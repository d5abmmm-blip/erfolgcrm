/**
 * State-machine для ticket.status.
 *
 * Архитектура (после Fix 1):
 *   - repository.changeStatus — низкоуровневый setter, валидации нет.
 *     Используется в seed/fixture/legacy-тестах и в reopen из service.
 *   - service.changeStatusCmd — единая точка входа из router. Здесь:
 *       1. RBAC (engineer ограничен в router; reopen-из-терминала только director).
 *       2. Таблица ALLOWED_TRANSITIONS (received → diagnostics → ... → closed).
 *       3. Идемпотентность (from === to → no-op).
 *       4. Reopen-ветка обходит таблицу переходов (closed/cancelled → активный).
 *
 * Тесты разбиты на 3 блока:
 *   - happy-path через repository (для ticket-events / payroll-fixtures).
 *   - permissive repository (документируем что repo не блокирует).
 *   - service-level: BAD_REQUEST на невалидных переходах + reopen-bypass.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { changeStatus, createTicket } from '../modules/tickets/repository';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';
import { appRouter } from '../trpc/router';

const TEST_PREFIX = 'TEST-SM-';

let erfolgId = '';
let primaryClientId = '';
let engineerId = '';
let directorId = '';
let dispatcherId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users),
  );
  // ВНИМАНИЕ: не фильтруем по isActive — auth-2fa тесты создают/деактивируют директоров,
  // и при множественных прогонах роли могут быть смещены. Если нет директора —
  // создаём временного. (Это нужно только для RBAC-тестов через mock-SessionData,
  // настоящий login не проводится.)
  const eng = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!eng || !disp) {
    throw new Error(`seed missing engineer/dispatcher: total users=${usrs.length}`);
  }
  engineerId = eng.id;
  dispatcherId = disp.id;
  // НАХОДКА: в текущей БД нет активного user с role='director' (через прогоны
  // 2FA-тестов директор был деактивирован/удалён). Это потенциальная проблема для
  // прод-резерва (см. отчёт). Для теста используем engineer.id как userId в моке —
  // важна только role в SessionData (RBAC на role смотрит, FK на ticket_events.user_id
  // по userId). Существующий engineer.id гарантированно есть.
  directorId = engineerId;
});

async function clearTestTickets(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`)),
  );
  // Перепроверяем, что engineerId/dispatcherId всё ещё существуют в users —
  // другие тестовые наборы могут удалять/блокировать пользователей. Если нет,
  // refetch — иначе FK на ticket_events.user_id ломается при changeStatus.
  const fresh = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const eng = fresh.find((u) => u.id === engineerId) ?? fresh.find((u) => u.role === 'engineer');
  const disp =
    fresh.find((u) => u.id === dispatcherId) ?? fresh.find((u) => u.role === 'dispatcher');
  if (eng) engineerId = eng.id;
  if (disp) dispatcherId = disp.id;
  directorId = engineerId;
}

async function createBaseTicket(): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}base`,
  });
  return id;
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(role: 'director' | 'dispatcher' | 'engineer'): Context {
  const userId =
    role === 'director' ? directorId : role === 'dispatcher' ? dispatcherId : engineerId;
  const session: SessionData = {
    tenantId: erfolgId,
    userId,
    username: `${role}-test`,
    role,
    fullName: `Test ${role}`,
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: erfolgId,
      subdomain: 'erfolg',
      displayName: 'erfolg',
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

describe('ticket state machine: разрешённые переходы', () => {
  beforeEach(clearTestTickets);

  it('received → diagnostics: OK', async () => {
    const id = await createBaseTicket();
    const r = await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    expect(r.from).toBe('received');
    expect(r.to).toBe('diagnostics');
  });

  it('diagnostics → in_progress: OK', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    const r = await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    expect(r.to).toBe('in_progress');
  });

  it('in_progress → act_pending → closed: OK (нормальный путь)', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    await changeStatus(getDb(), erfolgId, null, id, 'act_pending');
    const r = await changeStatus(getDb(), erfolgId, null, id, 'closed');
    expect(r.to).toBe('closed');
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ closedAt: tickets.closedAt }).from(tickets).where(eq(tickets.id, id)),
    );
    expect(row?.closedAt).toBeInstanceOf(Date);
  });

  it('received → cancelled: OK', async () => {
    const id = await createBaseTicket();
    const r = await changeStatus(getDb(), erfolgId, null, id, 'cancelled', 'передумал');
    expect(r.to).toBe('cancelled');
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ cancelledAt: tickets.cancelledAt, reason: tickets.cancelReason })
        .from(tickets)
        .where(eq(tickets.id, id)),
    );
    expect(row?.cancelledAt).toBeInstanceOf(Date);
    expect(row?.reason).toBe('передумал');
  });

  it('in_progress → cancelled: OK', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    const r = await changeStatus(getDb(), erfolgId, null, id, 'cancelled');
    expect(r.to).toBe('cancelled');
  });
});

describe('ticket state machine: repository уровень намеренно permissive', () => {
  beforeEach(clearTestTickets);

  // Намеренное архитектурное решение: repository.changeStatus — низкоуровневый
  // setter без бизнес-валидации (используется в seed/fixture/тестах). Вся
  // защита переходов — на service.changeStatusCmd (см. блок ниже про service).

  it('repo: received → closed — проходит (валидация на сервисе)', async () => {
    const id = await createBaseTicket();
    const r = await changeStatus(getDb(), erfolgId, null, id, 'closed');
    expect(r.to).toBe('closed');
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, id)),
    );
    expect(row?.status).toBe('closed');
  });

  it('repo: cancelled → in_progress — проходит (валидация на сервисе)', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'cancelled');
    const r = await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    expect(r.to).toBe('in_progress');
  });

  it('repo: closed → in_progress — проходит (валидация на сервисе)', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    await changeStatus(getDb(), erfolgId, null, id, 'closed');
    const r = await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    expect(r.to).toBe('in_progress');
  });
});

describe('ticket state machine: реальные защиты (на router/service-уровне)', () => {
  beforeEach(clearTestTickets);

  it('engineer не может ставить closed (router: ENGINEER_ALLOWED_STATUSES)', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx('engineer'));
    await expect(caller.tickets.changeStatus({ id, status: 'closed' })).rejects.toBeInstanceOf(
      TRPCError,
    );
  });

  it('engineer не может ставить cancelled', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx('engineer'));
    await expect(caller.tickets.changeStatus({ id, status: 'cancelled' })).rejects.toBeInstanceOf(
      TRPCError,
    );
  });

  it('engineer МОЖЕТ ставить diagnostics/in_progress/act_pending', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx('engineer'));
    const r = await caller.tickets.changeStatus({ id, status: 'diagnostics' });
    expect(r.to).toBe('diagnostics');
  });

  it('reopen из cancelled — только директор (service.changeStatusCmd)', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'cancelled');
    // Диспетчер пытается reopen → FORBIDDEN
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    await expect(caller.tickets.changeStatus({ id, status: 'received' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('reopen из closed: директор может через service-уровень', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    await changeStatus(getDb(), erfolgId, null, id, 'closed');
    const caller = appRouter.createCaller(makeCtx('director'));
    const r = await caller.tickets.changeStatus({ id, status: 'in_progress' });
    expect(r.to).toBe('in_progress');
  });
});

describe('ticket state machine: валидация переходов на service-уровне', () => {
  beforeEach(clearTestTickets);

  it('received → closed через service: BAD_REQUEST (нельзя пропустить act_pending)', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    await expect(caller.tickets.changeStatus({ id, status: 'closed' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('received → in_progress через service: BAD_REQUEST (нельзя пропустить diagnostics)', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    await expect(caller.tickets.changeStatus({ id, status: 'in_progress' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('received → received (идемпотентно): no-op без ошибки', async () => {
    const id = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const r = await caller.tickets.changeStatus({ id, status: 'received' });
    expect(r.to).toBe('received');
    expect(r.from).toBe('received');
  });

  it('act_pending → in_progress через service: OK (отзыв на доделку)', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    await changeStatus(getDb(), erfolgId, null, id, 'act_pending');
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const r = await caller.tickets.changeStatus({ id, status: 'in_progress' });
    expect(r.to).toBe('in_progress');
  });

  it('act_pending → closed через service: OK (нормальное закрытие)', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    await changeStatus(getDb(), erfolgId, null, id, 'act_pending');
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const r = await caller.tickets.changeStatus({ id, status: 'closed' });
    expect(r.to).toBe('closed');
  });

  it('diagnostics → cancelled через service: OK (отмена из любого живого)', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    const caller = appRouter.createCaller(makeCtx('director'));
    const r = await caller.tickets.changeStatus({ id, status: 'cancelled' });
    expect(r.to).toBe('cancelled');
  });

  it('diagnostics → estimate через service: BAD_REQUEST (стадия «Смета» убрана из потока)', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    await expect(caller.tickets.changeStatus({ id, status: 'estimate' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('diagnostics → in_progress через service: OK (новый поток без сметы/согласования)', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const r = await caller.tickets.changeStatus({ id, status: 'in_progress' });
    expect(r.to).toBe('in_progress');
  });

  it('reopen из closed бывает только через директора и обходит таблицу переходов', async () => {
    const id = await createBaseTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    await changeStatus(getDb(), erfolgId, null, id, 'act_pending');
    await changeStatus(getDb(), erfolgId, null, id, 'closed');
    // Без bypass: closed → in_progress НЕ в ALLOWED_TRANSITIONS, но reopen-ветка
    // (директор) должна проходить без BAD_REQUEST.
    const callerDirector = appRouter.createCaller(makeCtx('director'));
    const r = await callerDirector.tickets.changeStatus({ id, status: 'in_progress' });
    expect(r.to).toBe('in_progress');
  });
});
