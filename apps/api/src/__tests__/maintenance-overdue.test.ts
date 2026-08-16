/**
 * Тесты для maintenance: overdue / due_soon / recordPerformed.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { assets, getDb, maintenanceLog, maintenanceSchedules, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createSchedule, listSchedules, recordPerformed } from '../modules/maintenance/repository';
import { listMaintenanceForToday } from '../modules/dashboard/repository';

let erfolgId = '';
let assetId = '';

const TEST_NOTE_PREFIX = 'TEST-MAINT-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [a] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: assets.id }).from(assets).limit(1),
  );
  if (!a) throw new Error('seed missing asset');
  assetId = a.id;
});

async function clearTestSchedules(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx
      .delete(maintenanceSchedules)
      .where(like(maintenanceSchedules.notes, `${TEST_NOTE_PREFIX}%`));
    await tx.delete(maintenanceLog).where(like(maintenanceLog.summary, `${TEST_NOTE_PREFIX}%`));
  });
}

const day = 24 * 60 * 60 * 1000;

async function createWithDue(notes: string, daysFromNow: number, intervalDays = 90) {
  return withTenantTx(getDb(), erfolgId, async (tx) => {
    const [row] = await tx
      .insert(maintenanceSchedules)
      .values({
        tenantId: erfolgId,
        assetId,
        kind: 'planned',
        intervalDays,
        nextDueAt: new Date(Date.now() + daysFromNow * day),
        notes: `${TEST_NOTE_PREFIX}${notes}`,
      })
      .returning({ id: maintenanceSchedules.id });
    if (!row) throw new Error('insert');
    return row.id;
  });
}

describe('maintenance schedule filters', () => {
  beforeEach(async () => {
    await clearTestSchedules();
  });

  it('overdue: только просроченные', async () => {
    const overdueId = await createWithDue('overdue', -5);
    await createWithDue('soon', 3);
    await createWithDue('far', 30);

    const overdue = await listSchedules(getDb(), erfolgId, { filter: 'overdue' });
    const overdueIds = overdue.map((s) => s.id);
    expect(overdueIds).toContain(overdueId);
    // soon (3 дня) и far (30 дней) — НЕ просрочены.
    const soon = overdue.find((s) => s.notes === `${TEST_NOTE_PREFIX}soon`);
    expect(soon).toBeUndefined();
  });

  it('due_soon (7д): overdue + ближайшие', async () => {
    await createWithDue('overdue', -5);
    await createWithDue('soon', 3);
    const farId = await createWithDue('far', 30);

    const due = await listSchedules(getDb(), erfolgId, { filter: 'due_soon' });
    const farRow = due.find((s) => s.id === farId);
    expect(farRow).toBeUndefined();
    // overdue и soon должны попасть.
    expect(due.some((s) => s.notes === `${TEST_NOTE_PREFIX}overdue`)).toBe(true);
    expect(due.some((s) => s.notes === `${TEST_NOTE_PREFIX}soon`)).toBe(true);
  });

  it('recordPerformed обновляет last_done_at и next_due_at', async () => {
    const scheduleId = await createWithDue('record', -5, 90);
    const performedAt = new Date();

    await recordPerformed(getDb(), erfolgId, {
      assetId,
      scheduleId,
      performedAt,
      performedByUserId: null,
      summary: `${TEST_NOTE_PREFIX}performed`,
    });

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          lastDoneAt: maintenanceSchedules.lastDoneAt,
          nextDueAt: maintenanceSchedules.nextDueAt,
        })
        .from(maintenanceSchedules)
        .where(eq(maintenanceSchedules.id, scheduleId)),
    );
    expect(row?.lastDoneAt?.getTime()).toBe(performedAt.getTime());
    const expectedNext = new Date(performedAt.getTime() + 90 * day).getTime();
    expect(row?.nextDueAt.getTime()).toBe(expectedNext);
  });

  it('recordPerformed без scheduleId: лог записан, графики не трогаются', async () => {
    const result = await recordPerformed(getDb(), erfolgId, {
      assetId,
      performedAt: new Date(),
      performedByUserId: null,
      summary: `${TEST_NOTE_PREFIX}adhoc`,
    });
    expect(result.id).toBeTruthy();
  });

  it('createSchedule вычисляет next_due_at', async () => {
    const startAt = new Date();
    const result = await createSchedule(getDb(), erfolgId, {
      assetId,
      kind: 'planned',
      intervalDays: 30,
      startAt,
      notes: `${TEST_NOTE_PREFIX}create`,
    });
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ nextDueAt: maintenanceSchedules.nextDueAt })
        .from(maintenanceSchedules)
        .where(eq(maintenanceSchedules.id, result.id)),
    );
    const expectedNext = startAt.getTime() + 30 * day;
    expect(row?.nextDueAt.getTime()).toBe(expectedNext);
  });
});

/**
 * «Просрочено» у ТО — одно определение на все экраны.
 *
 * Было четыре разных: раздел ТО считал по метке времени (next_due_at <= now()),
 * дашборд давал сутки форы (next_due_at < now() - interval '1 day') в двух местах,
 * а список «ТО на сегодня» сравнивал по дате (next_due_at::date < CURRENT_DATE).
 * График, просроченный сегодня утром, был просрочен на одном экране и не просрочен
 * на другом — директор видел два разных числа и не знал, какому верить.
 *
 * Правило теперь одно: просрочено, если плановый ДЕНЬ уже прошёл.
 */
describe('просрочка ТО считается одинаково везде', () => {
  beforeEach(async () => {
    await clearTestSchedules();
  });

  /** Считает ли раздел ТО этот график просроченным. */
  async function overdueOnScreen(id: string): Promise<boolean> {
    const rows = await listSchedules(getDb(), erfolgId, { filter: 'overdue' });
    return rows.some((s) => s.id === id);
  }

  /** Считает ли его просроченным дашборд (список «ТО на сегодня»). */
  async function overdueOnDashboard(id: string): Promise<boolean> {
    const rows = await listMaintenanceForToday(getDb(), erfolgId, true, 500);
    return rows.some((r) => r.scheduleId === id && r.isOverdue);
  }

  it('график вчерашнего дня просрочен и в разделе ТО, и на дашборде', async () => {
    const id = await createWithDue('вчера', -1);
    expect(await overdueOnScreen(id)).toBe(true);
    expect(await overdueOnDashboard(id)).toBe(true);
  });

  it('график на сегодня не просрочен нигде — день ещё не кончился', async () => {
    const id = await createWithDue('сегодня', 0);
    expect(await overdueOnScreen(id)).toBe(false);
    expect(await overdueOnDashboard(id)).toBe(false);
  });

  it('график будущего дня не просрочен нигде', async () => {
    const id = await createWithDue('через три дня', 3);
    expect(await overdueOnScreen(id)).toBe(false);
    expect(await overdueOnDashboard(id)).toBe(false);
  });
});
