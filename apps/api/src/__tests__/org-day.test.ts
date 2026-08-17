/**
 * «Сегодня» — день в таймзоне ОРГАНИЗАЦИИ, а не базы данных и не UTC.
 *
 * ЗАЧЕМ. На бою Postgres живёт в UTC, организация — в Europe/Moscow (+3).
 * Всё, что сравнивалось с CURRENT_DATE (просрочка счетов и ТО, статус гарантий,
 * «событий сегодня» на дашборде) или с new Date().toISOString(), переключало
 * день в 03:00 по Москве, а не в полночь.
 *
 * КАК УСТРОЕН КОНТРАСТ. Два тестовых тенанта в поясах Pacific/Kiritimati
 * (UTC+14) и Etc/GMT+12 (UTC−12): между ними 26 часов, поэтому их календарные
 * дни НЕ совпадают ни в какой момент суток. Одинаковые записи в двух тенантах
 * обязаны классифицироваться ПО-РАЗНОМУ. Старый код (общий CURRENT_DATE сессии
 * БД) даёт обоим тенантам один ответ — в любой момент суток хотя бы одна из
 * парных проверок падает, тест детерминированно красный до правки, в какое бы
 * время его ни запускали.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  assets,
  calendarEvents,
  clients,
  getDb,
  maintenanceSchedules,
  tenants,
  warranties,
  withTenantTx,
} from '@erfolg/db';
import './setup';
import { dayInTimezone, orgDayValue, orgTodayValue, todayInTimezone } from '../lib/org-day';
import { createWarranty, getWarrantyById } from '../modules/warranties/repository';
import { listSchedules } from '../modules/maintenance/repository';
import { getNavBadgeCounts } from '../modules/dashboard/repository';

const TEST_PREFIX = 'TEST-ORGDAY-';
// Оба пояса без сезонных переводов; смещения стабильны круглый год.
const TZ_AHEAD = 'Pacific/Kiritimati'; // UTC+14
const OFF_AHEAD = '+14:00';
const TZ_BEHIND = 'Etc/GMT+12'; // UTC−12 (знак в Etc/* инвертирован)
const OFF_BEHIND = '-12:00';

interface TzTenant {
  id: string;
  tz: string;
  off: string;
  assetId: string;
}

let ahead: TzTenant;
let behind: TzTenant;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Снести тенанта прошлого прогона вместе с детьми (FK без каскада). */
async function dropTenantBySubdomain(sub: string): Promise<void> {
  const db = getDb();
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.subdomain, sub));
  const id = rows[0]?.id;
  if (!id) return;
  await withTenantTx(db, id, async (tx) => {
    await tx.delete(calendarEvents).where(like(calendarEvents.title, `${TEST_PREFIX}%`));
    await tx
      .delete(maintenanceSchedules)
      .where(like(maintenanceSchedules.notes, `${TEST_PREFIX}%`));
    await tx.delete(warranties).where(like(warranties.provider, `${TEST_PREFIX}%`));
    await tx.delete(assets).where(like(assets.model, `${TEST_PREFIX}%`));
    await tx.delete(clients).where(like(clients.displayName, `${TEST_PREFIX}%`));
  });
  await db.delete(tenants).where(eq(tenants.id, id));
}

async function makeTenant(sub: string, tz: string, off: string): Promise<TzTenant> {
  const db = getDb();
  await dropTenantBySubdomain(sub);
  const [t] = await db
    .insert(tenants)
    .values({ subdomain: sub, displayName: `${TEST_PREFIX}${tz}`, timezone: tz, status: 'active' })
    .returning({ id: tenants.id });
  const id = t!.id;
  const assetId = await withTenantTx(db, id, async (tx) => {
    const [c] = await tx
      .insert(clients)
      .values({
        tenantId: id,
        type: 'legal',
        subtype: 'commercial',
        displayName: `${TEST_PREFIX}Owner`,
        status: 'active',
      })
      .returning({ id: clients.id });
    const [a] = await tx
      .insert(assets)
      .values({
        tenantId: id,
        ownerClientId: c!.id,
        model: `${TEST_PREFIX}X1`,
        serialNumber: `${TEST_PREFIX}${sub}`,
      })
      .returning({ id: assets.id });
    return a!.id;
  });
  return { id, tz, off, assetId };
}

beforeAll(async () => {
  ahead = await makeTenant('test-orgday-ahead', TZ_AHEAD, OFF_AHEAD);
  behind = await makeTenant('test-orgday-behind', TZ_BEHIND, OFF_BEHIND);
});

afterAll(async () => {
  await dropTenantBySubdomain('test-orgday-ahead');
  await dropTenantBySubdomain('test-orgday-behind');
});

describe('org-day: «сегодня» в таймзоне организации', () => {
  it('дни двух поясов действительно не совпадают (санити контраста)', () => {
    const dayA = todayInTimezone(TZ_AHEAD);
    const dayB = todayInTimezone(TZ_BEHIND);
    expect(dayA).toBe(addDaysIso(dayB, 1));
  });

  it('SQL-зеркало отдаёт день СВОЕГО тенанта, а не общий день базы', async () => {
    const db = getDb();
    const a = await withTenantTx(db, ahead.id, (tx) => orgTodayValue(tx, ahead.id));
    const b = await withTenantTx(db, behind.id, (tx) => orgTodayValue(tx, behind.id));
    expect(a).toBe(todayInTimezone(TZ_AHEAD));
    expect(b).toBe(todayInTimezone(TZ_BEHIND));
    expect(a).not.toBe(b);
  });

  it('orgDayValue: день МОМЕНТА в поясе тенанта (Date уходит в SQL ISO-строкой)', async () => {
    // Пин на граблю: Date в параметре сырого фрагмента drizzle шлёт как toString(),
    // Postgres его не парсит — на этом падали ВСЕ параллельные платежи (cash-sync).
    const db = getDb();
    const instant = new Date('2026-08-17T21:30:00Z');
    const a = await withTenantTx(db, ahead.id, (tx) => orgDayValue(tx, ahead.id, instant));
    const b = await withTenantTx(db, behind.id, (tx) => orgDayValue(tx, behind.id, instant));
    expect(a).toBe('2026-08-18'); // 21:30Z в UTC+14 — уже 11:30 следующего дня
    expect(b).toBe('2026-08-17'); // 21:30Z в UTC−12 — ещё 09:30 того же дня
  });

  it('гарантии: один end_date — разный статус по поясу организации', async () => {
    const db = getDb();
    // «Сегодня» отстающего пояса = «вчера» опережающего.
    const endDate = todayInTimezone(TZ_BEHIND);
    const wa = await createWarranty(db, ahead.id, {
      assetId: ahead.assetId,
      startDate: addDaysIso(endDate, -100),
      endDate,
      provider: `${TEST_PREFIX}A`,
    });
    const wb = await createWarranty(db, behind.id, {
      assetId: behind.assetId,
      startDate: addDaysIso(endDate, -100),
      endDate,
      provider: `${TEST_PREFIX}B`,
    });
    // UTC+14: день уже прошёл → истекла. UTC−12: идёт → истекает (≤30 дней).
    expect((await getWarrantyById(db, ahead.id, wa.id))?.status).toBe('expired');
    expect((await getWarrantyById(db, behind.id, wb.id))?.status).toBe('expiring');
  });

  it('ТО: «вчера» пояса организации просрочено, «сегодня» — ещё нет', async () => {
    const db = getDb();
    for (const t of [ahead, behind]) {
      const today = todayInTimezone(t.tz);
      await withTenantTx(db, t.id, (tx) =>
        tx.insert(maintenanceSchedules).values([
          {
            tenantId: t.id,
            assetId: t.assetId,
            intervalDays: 30,
            nextDueAt: new Date(`${addDaysIso(today, -1)}T12:00:00${t.off}`),
            notes: `${TEST_PREFIX}yesterday`,
          },
          {
            tenantId: t.id,
            assetId: t.assetId,
            intervalDays: 30,
            nextDueAt: new Date(`${today}T12:00:00${t.off}`),
            notes: `${TEST_PREFIX}today`,
          },
        ]),
      );
      const overdue = await listSchedules(db, t.id, { filter: 'overdue' });
      const notes = overdue.filter((s) => s.notes?.startsWith(TEST_PREFIX)).map((s) => s.notes);
      expect(notes, `${t.tz}: вчерашний срок должен быть просрочен`).toContain(
        `${TEST_PREFIX}yesterday`,
      );
      expect(notes, `${t.tz}: сегодняшний срок ещё не просрочен`).not.toContain(
        `${TEST_PREFIX}today`,
      );
    }
  });

  it('дашборд: «событий сегодня» считает по дню организации', async () => {
    const db = getDb();
    const eventDate = todayInTimezone(TZ_BEHIND);
    for (const t of [ahead, behind]) {
      await withTenantTx(db, t.id, (tx) =>
        tx.insert(calendarEvents).values({
          tenantId: t.id,
          title: `${TEST_PREFIX}ev`,
          eventDate,
        }),
      );
    }
    const fakeUser = '00000000-0000-4000-8000-000000000001';
    const na = await getNavBadgeCounts(db, ahead.id, 'director', fakeUser);
    const nb = await getNavBadgeCounts(db, behind.id, 'director', fakeUser);
    // Для UTC+14 эта дата уже вчера, для UTC−12 — сегодня.
    expect(na.calendarToday).toBe(0);
    expect(nb.calendarToday).toBe(1);
  });

  it('граница суток Москвы: 21:00 UTC — уже завтра, 20:59 — ещё сегодня', () => {
    expect(dayInTimezone('Europe/Moscow', new Date('2026-08-17T21:30:00Z'))).toBe('2026-08-18');
    expect(dayInTimezone('Europe/Moscow', new Date('2026-08-17T20:59:00Z'))).toBe('2026-08-17');
    // Нечитаемая зона — фолбэк на UTC, как вела себя attendance.
    expect(dayInTimezone('битая/зона', new Date('2026-08-17T21:30:00Z'))).toBe('2026-08-17');
  });
});
