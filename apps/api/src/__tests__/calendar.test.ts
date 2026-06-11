/**
 * Тесты календаря компании (modules/calendar):
 *   • все 5 типов событий попадают в свой месяц: выезд по заявке, дедлайн,
 *     плановое ТО, окончание договора, окончание гарантии;
 *   • события соседнего месяца не подмешиваются;
 *   • cross-tenant: события demo не видны из erfolg (RLS).
 *
 * Месяц фиксированный далёкий (март 2031) — не пересекается с dev-данными.
 * Все timestamptz-моменты берём в полдень UTC: в поясе Europe/Moscow это
 * тот же календарный день, проверки детерминированы.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import {
  assets,
  contracts,
  getDb,
  maintenanceSchedules,
  tickets,
  warranties,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listMonthEvents,
  updateCalendarEvent,
} from '../modules/calendar';
import { createTicket } from '../modules/tickets/repository';
import { createContract } from '../modules/contracts/repository';
import { createWarranty } from '../modules/warranties/repository';

const TEST_PREFIX = 'TESTCAL-';
const TZ = 'Europe/Moscow';

let erfolgId = '';
let demoId = '';
let erfolgClientId = '';
let demoClientId = '';
let assetId = '';
let scheduledTicketId = '';
let deadlineTicketId = '';

async function createAsset(tenantId: string, clientId: string): Promise<string> {
  return withTenantTx(getDb(), tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO assets (tenant_id, owner_client_id, model, serial_number)
      VALUES (${tenantId}::uuid, ${clientId}::uuid, ${TEST_PREFIX + 'Аппарат УЗИ'}, ${TEST_PREFIX + Date.now()})
      RETURNING id
    `);
    const id = (rows as unknown as Array<{ id: string }>)[0]?.id;
    if (!id) throw new Error('insert asset failed');
    return id;
  });
}

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  const pickClient = async (tid: string) => {
    const rows = await withTenantTx(getDb(), tid, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM clients LIMIT 1`),
    );
    const id = (rows as unknown as Array<{ id: string }>)[0]?.id;
    if (!id) throw new Error(`seed missing client for ${tid}`);
    return id;
  };
  erfolgClientId = await pickClient(erfolgId);
  demoClientId = await pickClient(demoId);

  // 1. Запланированный выезд: 10 марта 2031.
  const t1 = await createTicket(getDb(), erfolgId, null, {
    clientId: erfolgClientId,
    symptom: `${TEST_PREFIX}scheduled-visit`,
  });
  scheduledTicketId = t1.id;
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .update(tickets)
      .set({ scheduledStartAt: new Date('2031-03-10T12:00:00Z') })
      .where(eq(tickets.id, t1.id)),
  );

  // 2. Дедлайн открытой заявки: 20 марта 2031.
  const t2 = await createTicket(getDb(), erfolgId, null, {
    clientId: erfolgClientId,
    symptom: `${TEST_PREFIX}deadline`,
    deadlineAt: new Date('2031-03-20T12:00:00Z'),
  });
  deadlineTicketId = t2.id;

  // 3. Договор истекает 5 марта 2031.
  await createContract(getDb(), erfolgId, {
    clientId: erfolgClientId,
    contractNumber: `${TEST_PREFIX}CAL-1`,
    contractDate: '2030-01-10',
    validUntil: '2031-03-05',
  });

  // 4-5. Гарантия (до 25 марта) и плановое ТО (15 марта) на одной технике.
  assetId = await createAsset(erfolgId, erfolgClientId);
  await createWarranty(getDb(), erfolgId, {
    assetId,
    startDate: '2030-03-25',
    endDate: '2031-03-25',
    provider: `${TEST_PREFIX}vendor`,
  });
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.insert(maintenanceSchedules).values({
      tenantId: erfolgId,
      assetId,
      intervalDays: 180,
      nextDueAt: new Date('2031-03-15T12:00:00Z'),
    }),
  );

  // Изоляция: договор demo в том же месяце не должен быть виден из erfolg.
  await createContract(getDb(), demoId, {
    clientId: demoClientId,
    contractNumber: `${TEST_PREFIX}DEMO-1`,
    contractDate: '2030-01-10',
    validUntil: '2031-03-07',
  });
});

afterAll(async () => {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.execute(sql`
        DELETE FROM maintenance_schedules WHERE asset_id IN
          (SELECT id FROM assets WHERE model LIKE ${TEST_PREFIX + '%'})
      `);
      await tx.delete(warranties).where(like(warranties.provider, `${TEST_PREFIX}%`));
      await tx.delete(contracts).where(like(contracts.contractNumber, `${TEST_PREFIX}%`));
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
      await tx.delete(assets).where(like(assets.model, `${TEST_PREFIX}%`));
      await tx.execute(sql`DELETE FROM calendar_events WHERE title LIKE ${TEST_PREFIX + '%'}`);
    });
  }
});

describe('calendar.month — события месяца', () => {
  it('возвращает все 5 типов событий в своих днях', async () => {
    const events = await listMonthEvents(getDb(), erfolgId, TZ, 2031, 3);

    const visit = events.find((e) => e.type === 'ticket' && e.id === scheduledTicketId);
    expect(visit?.date).toBe('2031-03-10');
    expect(visit?.time).not.toBeNull();

    const deadline = events.find(
      (e) => e.type === 'ticket_deadline' && e.id === deadlineTicketId,
    );
    expect(deadline?.date).toBe('2031-03-20');

    const contractEnd = events.find(
      (e) => e.type === 'contract_end' && e.title.includes(`${TEST_PREFIX}CAL-1`),
    );
    expect(contractEnd?.date).toBe('2031-03-05');

    const maint = events.find((e) => e.type === 'maintenance' && e.title.includes(TEST_PREFIX));
    expect(maint?.date).toBe('2031-03-15');

    const warranty = events.find(
      (e) => e.type === 'warranty_end' && e.title.includes(TEST_PREFIX),
    );
    expect(warranty?.date).toBe('2031-03-25');

    // Отсортировано по дате.
    const dates = events.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('события соседнего месяца не подмешиваются', async () => {
    const april = await listMonthEvents(getDb(), erfolgId, TZ, 2031, 4);
    expect(april.some((e) => e.id === scheduledTicketId)).toBe(false);
    expect(april.some((e) => e.title.includes(TEST_PREFIX))).toBe(false);
  });

  it('cross-tenant: договор demo не виден из erfolg', async () => {
    const events = await listMonthEvents(getDb(), erfolgId, TZ, 2031, 3);
    expect(events.some((e) => e.title.includes(`${TEST_PREFIX}DEMO-1`))).toBe(false);
    // А из demo — виден.
    const demoEvents = await listMonthEvents(getDb(), demoId, TZ, 2031, 3);
    expect(demoEvents.some((e) => e.title.includes(`${TEST_PREFIX}DEMO-1`))).toBe(true);
  });
});

describe('calendar — свои события (CRUD)', () => {
  it('create → видно в месяце с временем и заметкой; update меняет; delete убирает', async () => {
    const { id } = await createCalendarEvent(getDb(), erfolgId, null, {
      title: `${TEST_PREFIX}Поставка запчастей`,
      date: '2031-03-18',
      time: '14:30',
      notes: 'Привезут манжеты для тонометров',
    });

    let events = await listMonthEvents(getDb(), erfolgId, TZ, 2031, 3);
    const ev = events.find((e) => e.type === 'custom' && e.id === id);
    expect(ev?.date).toBe('2031-03-18');
    expect(ev?.time).toBe('14:30');
    expect(ev?.title).toBe(`${TEST_PREFIX}Поставка запчастей`);
    expect(ev?.notes).toContain('манжеты');

    // update: перенос на другой день без времени.
    const updated = await updateCalendarEvent(getDb(), erfolgId, id, {
      title: `${TEST_PREFIX}Поставка (перенос)`,
      date: '2031-03-19',
      time: null,
      notes: null,
    });
    expect(updated).toBe(true);
    events = await listMonthEvents(getDb(), erfolgId, TZ, 2031, 3);
    const moved = events.find((e) => e.type === 'custom' && e.id === id);
    expect(moved?.date).toBe('2031-03-19');
    expect(moved?.time).toBeNull();

    // delete (soft) — из месяца исчезает, повторный delete → false.
    expect(await deleteCalendarEvent(getDb(), erfolgId, id)).toBe(true);
    events = await listMonthEvents(getDb(), erfolgId, TZ, 2031, 3);
    expect(events.some((e) => e.type === 'custom' && e.id === id)).toBe(false);
    expect(await deleteCalendarEvent(getDb(), erfolgId, id)).toBe(false);
  });

  it('cross-tenant: своё событие demo не видно из erfolg (RLS)', async () => {
    const { id } = await createCalendarEvent(getDb(), demoId, null, {
      title: `${TEST_PREFIX}demo-событие`,
      date: '2031-03-12',
      time: null,
      notes: null,
    });
    const erfolgEvents = await listMonthEvents(getDb(), erfolgId, TZ, 2031, 3);
    expect(erfolgEvents.some((e) => e.id === id)).toBe(false);
    // Update из чужого tenant'а тоже не должен находить запись.
    expect(
      await updateCalendarEvent(getDb(), erfolgId, id, {
        title: 'x',
        date: '2031-03-12',
        time: null,
        notes: null,
      }),
    ).toBe(false);
  });
});
