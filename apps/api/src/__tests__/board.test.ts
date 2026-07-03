/**
 * Доска «кто чем занят / почему стоит» — backend.
 *
 * Тесты:
 *   1. tickets.board возвращает только активные заявки (closed/cancelled скрыты).
 *   2. Эффективная причина выводится из статуса: estimate/approval → waiting_client_approval;
 *      act_pending → ready_for_pickup (светофор зелёный — «готово, позвонить»).
 *   3. setBlockedReason проставляет blocked_reason + blocked_since, пишет событие note,
 *      причина видна на доске.
 *   4. reason='waiting_part' синхронизирует флаг waiting_for_part (инвариант доски).
 *   5. setWaitingForPart(true) проставляет blocked_reason='waiting_part'.
 *   6. reason=null снимает простой (blocked_reason и waiting_for_part очищаются).
 *   7. Светофор: старый простой (blocked_since давно) → red; свежая причина → yellow.
 *   8. Cross-tenant: заявки demo не видны в доске erfolg (RLS).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, ticketEvents, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-BOARD-';

let erfolgId = '';
let demoId = '';
let primaryClientId = '';
let secondaryClientIdDemo = '';
let engineerId = '';
let dispatcherId = '';
let directorId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client (erfolg)');
  primaryClientId = c.id;
  const [demoClient] = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!demoClient) throw new Error('seed missing client (demo)');
  secondaryClientIdDemo = demoClient.id;

  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const engineer = usrs.find((u) => u.role === 'engineer');
  if (!engineer) throw new Error('seed missing engineer');
  engineerId = engineer.id;
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!disp) throw new Error('seed missing dispatcher');
  dispatcherId = disp.id;
  const dir = usrs.find((u) => u.role === 'director');
  directorId = dir?.id ?? engineerId;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    });
  }
}

beforeEach(clearTestData);

async function createBaseTicket(opts?: { tenantId?: string; clientId?: string }): Promise<string> {
  const tid = opts?.tenantId ?? erfolgId;
  const cid = opts?.clientId ?? primaryClientId;
  const { id } = await createTicket(getDb(), tid, null, {
    clientId: cid,
    symptom: `${TEST_PREFIX}base`,
  });
  return id;
}

/** Прямое обновление статуса заявки в БД (минуя таблицу переходов) — для проверки вывода причины. */
async function forceStatus(ticketId: string, status: 'estimate' | 'approval' | 'act_pending' | 'closed'): Promise<void> {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .update(tickets)
      .set(
        status === 'closed'
          ? { status, closedAt: new Date() }
          : { status },
      )
      .where(eq(tickets.id, ticketId)),
  );
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(opts: {
  role: 'director' | 'dispatcher' | 'engineer';
  userId?: string;
  tenantId?: string;
}): Context {
  const tid = opts.tenantId ?? erfolgId;
  const userId =
    opts.userId ??
    (opts.role === 'director' ? directorId : opts.role === 'dispatcher' ? dispatcherId : engineerId);
  const session: SessionData = {
    tenantId: tid,
    userId,
    username: `${opts.role}-test`,
    role: opts.role,
    fullName: `Test ${opts.role}`,
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: tid,
      subdomain: tid === erfolgId ? 'erfolg' : 'demo',
      displayName: tid === erfolgId ? 'erfolg' : 'demo',
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    },
    session,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
  };
}

describe('Доска: tickets.board', () => {
  it('возвращает активные заявки и скрывает closed', async () => {
    const activeId = await createBaseTicket();
    const closedId = await createBaseTicket();
    await forceStatus(closedId, 'closed');

    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const board = await caller.tickets.board();
    const ids = board.map((t) => t.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(closedId);
  });

  it('выводит причину из статуса: estimate → waiting_client_approval', async () => {
    const id = await createBaseTicket();
    await forceStatus(id, 'estimate');
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const card = (await caller.tickets.board()).find((t) => t.id === id);
    expect(card?.effectiveReason).toBe('waiting_client_approval');
    expect(card?.blockedReason).toBeNull(); // явно не хранится
  });

  it('act_pending → ready_for_pickup, светофор зелёный', async () => {
    const id = await createBaseTicket();
    await forceStatus(id, 'act_pending');
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const card = (await caller.tickets.board()).find((t) => t.id === id);
    expect(card?.effectiveReason).toBe('ready_for_pickup');
    expect(card?.light).toBe('green');
  });
});

describe('Доска: setBlockedReason', () => {
  it('проставляет причину + blocked_since, пишет событие note', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await caller.tickets.setBlockedReason({
      ticketId: id,
      reason: 'waiting_payment',
      note: 'счёт выставлен 01.07',
    });

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ reason: tickets.blockedReason, since: tickets.blockedSince })
        .from(tickets)
        .where(eq(tickets.id, id)),
    );
    expect(row?.reason).toBe('waiting_payment');
    expect(row?.since).not.toBeNull();

    const events = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ type: ticketEvents.type, payload: ticketEvents.payload })
        .from(ticketEvents)
        .where(eq(ticketEvents.ticketId, id)),
    );
    const noteEvent = events.find(
      (e) => e.type === 'note' && String(e.payload?.comment ?? '').includes('Причина простоя'),
    );
    expect(noteEvent).toBeDefined();

    const card = (await caller.tickets.board()).find((t) => t.id === id);
    expect(card?.effectiveReason).toBe('waiting_payment');
    expect(card?.light).toBe('yellow'); // причина есть, но простой свежий
  });

  it("reason='waiting_part' синхронизирует флаг waiting_for_part", async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await caller.tickets.setBlockedReason({ ticketId: id, reason: 'waiting_part', note: 'диод' });
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ wfp: tickets.waitingForPart, note: tickets.waitingForPartNote })
        .from(tickets)
        .where(eq(tickets.id, id)),
    );
    expect(row?.wfp).toBe(true);
    expect(row?.note).toBe('диод');
  });

  it('reason=null снимает простой (причина и флаг очищаются)', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await caller.tickets.setBlockedReason({ ticketId: id, reason: 'waiting_part', note: 'x' });
    await caller.tickets.setBlockedReason({ ticketId: id, reason: null, note: null });
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          reason: tickets.blockedReason,
          since: tickets.blockedSince,
          wfp: tickets.waitingForPart,
        })
        .from(tickets)
        .where(eq(tickets.id, id)),
    );
    expect(row?.reason).toBeNull();
    expect(row?.since).toBeNull();
    expect(row?.wfp).toBe(false);
  });
});

describe('Доска: setWaitingForPart ↔ blocked_reason', () => {
  it('setWaitingForPart(true) проставляет blocked_reason=waiting_part', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await caller.tickets.setWaitingForPart({ ticketId: id, waiting: true, note: 'плата' });
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ reason: tickets.blockedReason, since: tickets.blockedSince })
        .from(tickets)
        .where(eq(tickets.id, id)),
    );
    expect(row?.reason).toBe('waiting_part');
    expect(row?.since).not.toBeNull();
  });
});

describe('Доска: светофор', () => {
  it('старый простой (blocked_since 10 дней назад) → red', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await caller.tickets.setBlockedReason({ ticketId: id, reason: 'waiting_management_decision', note: null });
    // Отматываем начало простоя на 10 дней назад.
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(tickets).set({ blockedSince: tenDaysAgo }).where(eq(tickets.id, id)),
    );
    const card = (await caller.tickets.board()).find((t) => t.id === id);
    expect(card?.light).toBe('red');
    expect(card?.stuckDays).toBeGreaterThanOrEqual(7);
  });
});

describe('Доска: cross-tenant', () => {
  it('заявки demo не видны в доске erfolg (RLS)', async () => {
    const erfolgTicket = await createBaseTicket();
    const demoTicket = await createBaseTicket({
      tenantId: demoId,
      clientId: secondaryClientIdDemo,
    });
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const ids = (await caller.tickets.board()).map((t) => t.id);
    expect(ids).toContain(erfolgTicket);
    expect(ids).not.toContain(demoTicket);
  });
});
