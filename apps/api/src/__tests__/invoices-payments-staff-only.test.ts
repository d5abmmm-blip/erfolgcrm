/**
 * Счета и платежи — только staff (диспетчер + директор).
 *
 * Решение владельца 2026-08-11: «инженеру не нужны счета, у инженера только
 * техническая часть вопроса». Раньше invoices.getById / invoices.listByTicket /
 * payments.listByTicket / payments.getTotals были engineerProcedure — суммы
 * счетов и оплат любой заявки читались инженером и оседали в телефоне.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-INV-STAFF-';

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

/** Заявка, назначенная на сид-инженера — даже по СВОЕЙ заявке денег ему не видно. */
async function makeOwnTicket(): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}ticket`,
    assignedEngineerId: engineerId,
  });
  return id;
}

describe('счета и платежи — только staff', () => {
  it('инженеру отказ даже по своей заявке (счета, платежи, итоги оплат)', async () => {
    const ticketId = await makeOwnTicket();
    const engineer = appRouter.createCaller(makeCtx('engineer'));

    await expect(engineer.invoices.listByTicket({ ticketId })).rejects.toThrow();
    await expect(engineer.payments.listByTicket({ ticketId })).rejects.toThrow();
    await expect(engineer.payments.getTotals({ ticketId })).rejects.toThrow();
  });

  it('диспетчеру — как раньше', async () => {
    const ticketId = await makeOwnTicket();
    const dispatcher = appRouter.createCaller(makeCtx('dispatcher'));

    await expect(dispatcher.invoices.listByTicket({ ticketId })).resolves.toEqual([]);
    await expect(dispatcher.payments.listByTicket({ ticketId })).resolves.toEqual([]);
    // Наряда у свежей заявки нет — getTotals честно отдаёт null, а не бросает.
    await expect(dispatcher.payments.getTotals({ ticketId })).resolves.toBeNull();
  });
});
