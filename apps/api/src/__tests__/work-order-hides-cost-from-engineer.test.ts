/**
 * Себестоимость и маржа наряда — отчётные цифры директора (profitability),
 * инженеру они не показываются ни на одном экране. Но workOrders.getByTicket
 * отдавал их в DTO любому инженеру — и они оседали в офлайн-кэше телефона
 * (снимок заявок хранится в IndexedDB). Теперь инженеру эти поля обнуляются;
 * staff получает как раньше.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  tickets,
  users,
  withTenantTx,
  workOrders,
  workOrderLines,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-HIDE-COST-';

let erfolgId = '';
let clientId = '';
let engineerId = '';
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
  const eng = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!eng || !disp) throw new Error('seed missing engineer/dispatcher');
  engineerId = eng.id;
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

function makeCtx(role: 'dispatcher' | 'engineer'): Context {
  const session: SessionData = {
    tenantId: erfolgId,
    userId: role === 'engineer' ? engineerId : dispatcherId,
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

/** Заявка инженера с нарядом, у которого ненулевые себестоимость и маржа. */
async function makeTicketWithCost(): Promise<string> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}ticket`,
    assignedEngineerId: engineerId,
  });
  const dispatcher = appRouter.createCaller(makeCtx('dispatcher'));
  await dispatcher.workOrders.ensure({ ticketId });
  const { id: lineId } = await dispatcher.workOrders.upsertLine({
    ticketId,
    line: { lineType: 'work', name: 'Ремонт', unit: 'шт', quantity: '1', unitPriceRub: 10000 },
  });
  // Себестоимость и маржа задаются напрямую: их значения в DTO читаются из
  // колонок как есть, а получить ненулевые через API зависело бы от процентов
  // зарплаты в сиде.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx
      .update(workOrderLines)
      .set({ costPerUnitKopecks: 777_700n })
      .where(eq(workOrderLines.id, lineId));
    await tx
      .update(workOrders)
      .set({ costAmountKopecks: 555_500n, marginAmountKopecks: 111_100n })
      .where(eq(workOrders.ticketId, ticketId));
  });
  return ticketId;
}

describe('getByTicket не отдаёт инженеру себестоимость и маржу', () => {
  it('инженеру по своей заявке — нули вместо отчётных цифр', async () => {
    const ticketId = await makeTicketWithCost();
    const engineer = appRouter.createCaller(makeCtx('engineer'));

    const wo = await engineer.workOrders.getByTicket({ ticketId });
    expect(wo?.costAmountKopecks).toBe('0');
    expect(wo?.marginAmountKopecks).toBe('0');
    expect(wo?.lines[0]?.costPerUnitKopecks).toBe('0');
    // Всё остальное инженер видит как раньше.
    expect(wo?.lines[0]?.unitPriceKopecks).toBe('1000000');
  });

  it('диспетчеру — как лежит в базе', async () => {
    const ticketId = await makeTicketWithCost();
    const dispatcher = appRouter.createCaller(makeCtx('dispatcher'));

    const wo = await dispatcher.workOrders.getByTicket({ ticketId });
    expect(wo?.costAmountKopecks).toBe('555500');
    expect(wo?.marginAmountKopecks).toBe('111100');
    expect(wo?.lines[0]?.costPerUnitKopecks).toBe('777700');
  });
});
