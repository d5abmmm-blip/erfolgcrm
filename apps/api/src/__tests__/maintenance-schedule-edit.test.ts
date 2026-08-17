/**
 * Правка графика ТО: смена интервала обязана двигать срок следующего ТО.
 *
 * ЧТО СЛУЧИЛОСЬ. `maintenance.updateSchedule` существует с самого начала, но
 * его никто не звал — в интерфейсе не было ни правки графика, ни выключения.
 * Когда стал делаться экран, выяснилось: `updateSchedule` меняет
 * `interval_days` и НЕ трогает `next_due_at`. То есть менеджер, поправивший
 * «раз в год» на «раз в полгода», увидел бы ровно ту же дату следующего ТО и
 * решил, что программа его не послушала.
 *
 * ПРАВИЛО СРОКА одно на весь модуль и берётся из уже написанного кода:
 *   next_due_at = база + интервал,
 * где база — дата последнего фактического ТО (`recordPerformed` ставит именно
 * `performedAt + interval`), а если ТО ещё не было — точка отсчёта, от которой
 * график завели (`createSchedule`: `startAt + interval`). Своей даты она нигде
 * не хранит, поэтому при пустом last_done_at восстанавливаем её вычитанием:
 * `next_due_at − старый интервал`. Пятого определения срока не заводим —
 * ровно та же причина, по которой «просрочено» свели в одно правило (#165).
 *
 * Что тест НЕ проверяет: выключение графика. Оно и до правки работало —
 * `is_active` пишется прямым патчем; ниже оно идёт контролем, чтобы правка
 * пересчёта его не задела.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { assets, clients, getDb, maintenanceSchedules, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { listSchedules, updateSchedule } from '../modules/maintenance/repository';

const TEST_PREFIX = 'TESTSCHEDEDIT-';
const DAY = 24 * 60 * 60 * 1000;

let erfolgId = '';
let clientId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.execute(sql`
      DELETE FROM maintenance_schedules WHERE asset_id IN
        (SELECT id FROM assets WHERE model LIKE ${`${TEST_PREFIX}%`})
    `);
    await tx.delete(assets).where(like(assets.model, `${TEST_PREFIX}%`));
  });
}
beforeEach(clearTestData);
afterAll(clearTestData);

/** График с заданным интервалом и (не)заполненной датой последнего ТО. */
async function makeSchedule(opts: {
  intervalDays: number;
  nextDueAt: Date;
  lastDoneAt?: Date | null;
}): Promise<string> {
  return withTenantTx(getDb(), erfolgId, async (tx) => {
    const a = await tx.execute<{ id: string }>(sql`
      INSERT INTO assets (tenant_id, owner_client_id, model, serial_number)
      VALUES (${erfolgId}::uuid, ${clientId}::uuid,
              ${`${TEST_PREFIX}Аппарат`}, ${`${TEST_PREFIX}${Date.now()}${Math.random()}`})
      RETURNING id
    `);
    const assetId = (a as unknown as Array<{ id: string }>)[0]?.id;
    if (!assetId) throw new Error('insert asset failed');
    const [s] = await tx
      .insert(maintenanceSchedules)
      .values({
        tenantId: erfolgId,
        assetId,
        kind: 'planned',
        intervalDays: opts.intervalDays,
        lastDoneAt: opts.lastDoneAt ?? null,
        nextDueAt: opts.nextDueAt,
        notes: `${TEST_PREFIX}график`,
      })
      .returning({ id: maintenanceSchedules.id });
    if (!s) throw new Error('insert schedule failed');
    return s.id;
  });
}

async function readSchedule(
  id: string,
): Promise<{ intervalDays: number; nextDueAt: Date; isActive: boolean }> {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({
        intervalDays: maintenanceSchedules.intervalDays,
        nextDueAt: maintenanceSchedules.nextDueAt,
        isActive: maintenanceSchedules.isActive,
      })
      .from(maintenanceSchedules)
      .where(eq(maintenanceSchedules.id, id))
      .limit(1),
  );
  if (!row) throw new Error('schedule not found');
  return row;
}

/** Даты сравниваем с точностью до суток: интервал задаётся в днях. */
function expectSameDay(actual: Date, expected: Date): void {
  expect(Math.abs(actual.getTime() - expected.getTime())).toBeLessThan(DAY / 2);
}

describe('смена интервала двигает срок следующего ТО', () => {
  it('ТО ещё не было: срок отсчитывается от той же точки, что и при заведении', async () => {
    // Завели «раз в год» 1 марта → следующее 1 марта следующего года.
    const start = new Date('2026-03-01T09:00:00Z');
    const id = await makeSchedule({
      intervalDays: 365,
      nextDueAt: new Date(start.getTime() + 365 * DAY),
      lastDoneAt: null,
    });

    await updateSchedule(getDb(), erfolgId, id, { intervalDays: 180 });

    const after = await readSchedule(id);
    expect(after.intervalDays).toBe(180);
    expectSameDay(after.nextDueAt, new Date(start.getTime() + 180 * DAY));
  });

  it('ТО было: срок отсчитывается от последнего фактического', async () => {
    const lastDone = new Date('2026-06-10T09:00:00Z');
    const id = await makeSchedule({
      intervalDays: 90,
      nextDueAt: new Date(lastDone.getTime() + 90 * DAY),
      lastDoneAt: lastDone,
    });

    await updateSchedule(getDb(), erfolgId, id, { intervalDays: 30 });

    const after = await readSchedule(id);
    expect(after.intervalDays).toBe(30);
    expectSameDay(after.nextDueAt, new Date(lastDone.getTime() + 30 * DAY));
  });

  it('интервал не меняли — срок остаётся нетронутым', async () => {
    const due = new Date('2026-09-01T09:00:00Z');
    const id = await makeSchedule({ intervalDays: 180, nextDueAt: due, lastDoneAt: null });

    await updateSchedule(getDb(), erfolgId, id, { notes: 'сменили только заметку' });

    const after = await readSchedule(id);
    expectSameDay(after.nextDueAt, due);
  });

  it('тот же интервал прислали повторно — срок не съезжает', async () => {
    const start = new Date('2026-03-01T09:00:00Z');
    const due = new Date(start.getTime() + 365 * DAY);
    const id = await makeSchedule({ intervalDays: 365, nextDueAt: due, lastDoneAt: null });

    await updateSchedule(getDb(), erfolgId, id, { intervalDays: 365 });

    const after = await readSchedule(id);
    expectSameDay(after.nextDueAt, due);
  });
});

describe('выключение графика (контроль — работало и раньше)', () => {
  it('выключенный уходит из активных и находится по фильтру «выключенные»', async () => {
    const id = await makeSchedule({
      intervalDays: 90,
      nextDueAt: new Date(Date.now() - 10 * DAY),
      lastDoneAt: null,
    });

    expect(
      (await listSchedules(getDb(), erfolgId, { filter: 'overdue' })).some((s) => s.id === id),
    ).toBe(true);

    await updateSchedule(getDb(), erfolgId, id, { isActive: false });

    expect(
      (await listSchedules(getDb(), erfolgId, { filter: 'overdue' })).some((s) => s.id === id),
    ).toBe(false);
    expect(
      (await listSchedules(getDb(), erfolgId, { filter: 'inactive' })).some((s) => s.id === id),
    ).toBe(true);
    expect((await readSchedule(id)).isActive).toBe(false);

    // Включаем обратно — график возвращается вместе со своим сроком.
    await updateSchedule(getDb(), erfolgId, id, { isActive: true });
    expect(
      (await listSchedules(getDb(), erfolgId, { filter: 'overdue' })).some((s) => s.id === id),
    ).toBe(true);
  });
});
