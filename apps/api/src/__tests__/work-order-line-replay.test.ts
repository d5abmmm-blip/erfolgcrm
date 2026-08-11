/**
 * Реплей офлайн-очереди не задваивает строку наряда.
 *
 * Сценарий из жизни: менеджер добавил строку, запрос ДОШЁЛ до сервера, строка
 * вставилась — а ответ потерялся (обрыв мобильной сети). Клиент считает это
 * сетевым сбоем и кладёт мутацию в очередь; реплей вставлял ВТОРУЮ строку —
 * счёт клиенту ×2 и сделка инженера ×2.
 *
 * Лечение: при создании строки клиент передаёт свой id (line.newId, uuid) —
 * вставка становится идемпотентной (INSERT ... ON CONFLICT (id) DO UPDATE,
 * guard по workOrderId). Повтор с тем же newId не плодит строку, а доносит
 * последнее состояние; id, занятый строкой ДРУГОГО наряда, — отказ.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { getDb, clients, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-LINE-REPLAY-';

let erfolgId = '';
let clientId = '';
let dispatcherId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!disp) throw new Error('seed missing dispatcher');
  dispatcherId = disp.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function dispatcherCtx(): Context {
  const session: SessionData = {
    tenantId: erfolgId,
    userId: dispatcherId,
    username: 'dispatcher-test',
    role: 'dispatcher',
    fullName: 'Test dispatcher',
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

async function makeTicketWithWorkOrder(): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}ticket`,
  });
  const caller = appRouter.createCaller(dispatcherCtx());
  await caller.workOrders.ensure({ ticketId: id });
  return id;
}

function lineInput(newId: string, priceRub: number, name = 'Замена платы управления') {
  return {
    newId,
    lineType: 'work' as const,
    name,
    unit: 'шт',
    quantity: '1',
    unitPriceRub: priceRub,
  };
}

describe('реплей вставки строки наряда идемпотентен', () => {
  it('повтор с тем же newId не создаёт вторую строку', async () => {
    const ticketId = await makeTicketWithWorkOrder();
    const caller = appRouter.createCaller(dispatcherCtx());
    const newId = crypto.randomUUID();

    const first = await caller.workOrders.upsertLine({ ticketId, line: lineInput(newId, 18000) });
    // Реплей той же записи очереди (ответ первой попытки потерялся).
    const second = await caller.workOrders.upsertLine({ ticketId, line: lineInput(newId, 18000) });

    expect(first.id).toBe(newId);
    expect(second.id).toBe(newId);
    const wo = await caller.workOrders.getByTicket({ ticketId });
    expect(wo?.lines.length).toBe(1);
  });

  it('реплей доносит последнее состояние строки (очередь склеивает правки)', async () => {
    const ticketId = await makeTicketWithWorkOrder();
    const caller = appRouter.createCaller(dispatcherCtx());
    const newId = crypto.randomUUID();

    await caller.workOrders.upsertLine({ ticketId, line: lineInput(newId, 18000) });
    // В очереди лежало уже подправленное состояние той же строки.
    await caller.workOrders.upsertLine({ ticketId, line: lineInput(newId, 21000) });

    const wo = await caller.workOrders.getByTicket({ ticketId });
    expect(wo?.lines.length).toBe(1);
    expect(wo?.lines[0]?.unitPriceKopecks).toBe('2100000');
  });

  it('newId, занятый строкой другого наряда, — отказ, чужая строка цела', async () => {
    const ticketA = await makeTicketWithWorkOrder();
    const ticketB = await makeTicketWithWorkOrder();
    const caller = appRouter.createCaller(dispatcherCtx());
    const newId = crypto.randomUUID();

    await caller.workOrders.upsertLine({ ticketId: ticketA, line: lineInput(newId, 18000) });
    await expect(
      caller.workOrders.upsertLine({ ticketId: ticketB, line: lineInput(newId, 99000) }),
    ).rejects.toThrow();

    const a = await caller.workOrders.getByTicket({ ticketId: ticketA });
    const b = await caller.workOrders.getByTicket({ ticketId: ticketB });
    expect(a?.lines.length).toBe(1);
    expect(a?.lines[0]?.unitPriceKopecks).toBe('1800000'); // не перезаписана
    expect(b?.lines.length).toBe(0);
  });

  it('вставка без newId работает как раньше (id выдаёт сервер)', async () => {
    const ticketId = await makeTicketWithWorkOrder();
    const caller = appRouter.createCaller(dispatcherCtx());

    const res = await caller.workOrders.upsertLine({
      ticketId,
      line: {
        lineType: 'work' as const,
        name: 'Диагностика',
        unit: 'шт',
        quantity: '1',
        unitPriceRub: 1500,
      },
    });
    expect(res.id).toBeTruthy();
    const wo = await caller.workOrders.getByTicket({ ticketId });
    expect(wo?.lines.length).toBe(1);
  });
});
