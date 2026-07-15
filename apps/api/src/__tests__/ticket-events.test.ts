/**
 * Тесты на бизнес-инвариант: при изменении статуса / назначения /
 * приоритета / SLA в tickets автоматически появляется ticket_event
 * соответствующего типа. Заметки/печать тоже порождают event.
 *
 * Используем repository-функции напрямую — фокус на инварианте.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  tickets,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  addNote,
  changeStatus,
  createTicket,
  listEvents,
  recordPrintEvent,
  setWaitingForPart,
  updateTicket,
} from '../modules/tickets/repository';

let erfolgId = '';
let primaryClientId = '';
let engineerId = '';
let dispatcherId = '';

const TEST_PREFIX = 'TEST-EVT-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;

  const [c] = await withTenantTx(getDb(), erfolgId, async (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;

  const usrs = await withTenantTx(getDb(), erfolgId, async (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  engineerId = usrs.find((u) => u.role === 'engineer')!.id;
  dispatcherId = usrs.find((u) => u.role === 'dispatcher')!.id;
});

async function clearTestTickets(): Promise<void> {
  // Удаляем тикеты, созданные в тестах. Идентифицируем по symptom-метке;
  // ticket_number мы не контролируем — он сквозной счётчик.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}

async function createBaseTicket(): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}base`,
  });
  return id;
}

describe('ticket_events: бизнес-инвариант', () => {
  beforeEach(async () => {
    await clearTestTickets();
  });

  it('createTicket → ровно один event "created"', async () => {
    const id = await createBaseTicket();
    const events = await listEvents(getDb(), erfolgId, id);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('created');
  });

  it('changeStatus(received → diagnostics) → event status_change с from/to', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    const events = await listEvents(getDb(), erfolgId, id);
    expect(events.length).toBe(2);
    const top = events[0]!;
    expect(top.type).toBe('status_change');
    expect(top.payload.from).toBe('received');
    expect(top.payload.to).toBe('diagnostics');
  });

  it('update assignedEngineerId → assignment_change с role=engineer', async () => {
    const id = await createBaseTicket();
    await updateTicket(getDb(), erfolgId, null, id, { assignedEngineerId: engineerId });
    const events = await listEvents(getDb(), erfolgId, id);
    const top = events[0]!;
    expect(top.type).toBe('assignment_change');
    expect(top.payload.role).toBe('engineer');
    expect(top.payload.from).toBe(null);
    expect(top.payload.to).toBe(engineerId);
  });

  it('update assignedDispatcherId → assignment_change с role=dispatcher', async () => {
    const id = await createBaseTicket();
    await updateTicket(getDb(), erfolgId, null, id, { assignedDispatcherId: dispatcherId });
    const events = await listEvents(getDb(), erfolgId, id);
    const top = events[0]!;
    expect(top.type).toBe('assignment_change');
    expect(top.payload.role).toBe('dispatcher');
    expect(top.payload.to).toBe(dispatcherId);
  });

  it('update priority → priority_change', async () => {
    const id = await createBaseTicket();
    await updateTicket(getDb(), erfolgId, null, id, { priority: 'urgent' });
    const events = await listEvents(getDb(), erfolgId, id);
    const top = events[0]!;
    expect(top.type).toBe('priority_change');
    expect(top.payload.from).toBe('normal');
    expect(top.payload.to).toBe('urgent');
  });

  it('update slaTargetAt → sla_change', async () => {
    const id = await createBaseTicket();
    const target = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await updateTicket(getDb(), erfolgId, null, id, { slaTargetAt: target });
    const events = await listEvents(getDb(), erfolgId, id);
    const top = events[0]!;
    expect(top.type).toBe('sla_change');
  });

  it('createTicket → авто-SLA по приоритету (обычный = 24 ч от приёма)', async () => {
    const id = await createBaseTicket();
    const [row] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, id)).limit(1),
    );
    expect(row?.slaTargetAt).toBeInstanceOf(Date);
    // received_at и sla_target_at считаются от одного и того же now → ровно 24 часа.
    expect(row!.slaTargetAt!.getTime() - row!.receivedAt.getTime()).toBe(24 * 3600 * 1000);
  });

  it('createTicket(priority=urgent) → авто-SLA = 4 ч', async () => {
    const { id } = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}urgent`,
      priority: 'urgent',
    });
    const [row] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, id)).limit(1),
    );
    expect(row!.slaTargetAt!.getTime() - row!.receivedAt.getTime()).toBe(4 * 3600 * 1000);
  });

  it('createTicket с явным slaTargetAt → авто-расчёт его не перебивает', async () => {
    const explicit = new Date(Date.now() + 90 * 3600 * 1000);
    const { id } = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}explicit`,
      priority: 'urgent',
      slaTargetAt: explicit,
    });
    const [row] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, id)).limit(1),
    );
    expect(row!.slaTargetAt!.getTime()).toBe(explicit.getTime());
  });

  it('update priority → SLA пересчитан от приёма, без отдельного события sla_change', async () => {
    const id = await createBaseTicket();
    const [beforeRow] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, id)).limit(1),
    );
    await updateTicket(getDb(), erfolgId, null, id, { priority: 'urgent' });
    const [afterRow] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, id)).limit(1),
    );
    // urgent = 4 ч от того же received_at; срок реально изменился.
    expect(afterRow!.slaTargetAt!.getTime() - afterRow!.receivedAt.getTime()).toBe(4 * 3600 * 1000);
    expect(afterRow!.slaTargetAt!.getTime()).not.toBe(beforeRow!.slaTargetAt!.getTime());
    // Смена приоритета порождает priority_change, но не отдельный sla_change.
    const events = await listEvents(getDb(), erfolgId, id);
    expect(events[0]!.type).toBe('priority_change');
    expect(events.some((e) => e.type === 'sla_change')).toBe(false);
  });

  it('переход в act_pending снимает «ждём запчасть» и старый blocked_since (готовую не красим)', async () => {
    const id = await createBaseTicket();
    // Инженер поставил «ждём запчасть» — появляется blocked_since (причина простоя).
    await setWaitingForPart(getDb(), erfolgId, null, id, true, 'плата питания');
    // Деталь ехала долго — состарим blocked_since на 15 дней назад.
    const old = new Date(Date.now() - 15 * 86_400_000);
    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx.update(tickets).set({ blockedSince: old }).where(eq(tickets.id, id));
    });
    // Инженер закончил и нажал «Готов к акту».
    await changeStatus(getDb(), erfolgId, null, id, 'act_pending');
    const [row] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, id)).limit(1),
    );
    // Блокировка снята → светофор посчитает «готово только что» (зелёный), а не «лежит 15 дн».
    expect(row?.status).toBe('act_pending');
    expect(row?.blockedReason).toBeNull();
    expect(row?.blockedSince).toBeNull();
    expect(row?.waitingForPart).toBe(false);
    expect(row?.waitingForPartNote).toBeNull();
  });

  it('changeStatus(in_progress → closed) → закрывается closed_at, event status_change', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    await changeStatus(getDb(), erfolgId, null, id, 'closed');
    const [row] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, id)).limit(1),
    );
    expect(row?.closedAt).toBeInstanceOf(Date);
    const events = await listEvents(getDb(), erfolgId, id);
    expect(events[0]!.type).toBe('status_change');
    expect(events[0]!.payload.to).toBe('closed');
  });

  it('changeStatus(received → cancelled, reason) → cancelled_at и reason заполнены', async () => {
    const id = await createBaseTicket();
    const reason = 'Клиент отказался от ремонта';
    await changeStatus(getDb(), erfolgId, null, id, 'cancelled', reason);
    const [row] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, id)).limit(1),
    );
    expect(row?.cancelledAt).toBeInstanceOf(Date);
    expect(row?.cancelReason).toBe(reason);
  });

  it('update только notes → 0 новых событий', async () => {
    const id = await createBaseTicket();
    const before = await listEvents(getDb(), erfolgId, id);
    await updateTicket(getDb(), erfolgId, null, id, { notes: 'просто заметка' });
    const after = await listEvents(getDb(), erfolgId, id);
    expect(after.length).toBe(before.length);
  });

  it('addNote → event note с comment', async () => {
    const id = await createBaseTicket();
    await addNote(getDb(), erfolgId, null, id, 'тестовая заметка');
    const events = await listEvents(getDb(), erfolgId, id);
    expect(events[0]!.type).toBe('note');
    expect(events[0]!.payload.comment).toBe('тестовая заметка');
  });

  it('recordPrint → event document_printed с documentKind', async () => {
    const id = await createBaseTicket();
    await recordPrintEvent(getDb(), erfolgId, null, id, 'intake_act');
    const events = await listEvents(getDb(), erfolgId, id);
    expect(events[0]!.type).toBe('document_printed');
    expect(events[0]!.payload.documentKind).toBe('intake_act');
  });

  it('listEvents отсортирован newest-first', async () => {
    const id = await createBaseTicket();
    await new Promise((r) => setTimeout(r, 5));
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    await new Promise((r) => setTimeout(r, 5));
    await addNote(getDb(), erfolgId, null, id, 'note');
    const events = await listEvents(getDb(), erfolgId, id);
    expect(events[0]!.type).toBe('note');
    expect(events[events.length - 1]!.type).toBe('created');
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        events[i]!.createdAt.getTime(),
      );
    }
  });
});
