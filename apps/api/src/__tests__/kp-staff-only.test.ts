/**
 * Суммы коммерческих предложений — только staff.
 *
 * Решение владельца 2026-08-11 («не нужны ему видеть» — про инженера и КП):
 * раньше ticketKp.listByTicket / latest были engineerProcedure, и суммы КП
 * любой заявки читались инженером.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-KP-STAFF-';

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

describe('КП — только staff', () => {
  it('инженеру отказ даже по своей заявке (список и последняя версия)', async () => {
    const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
      clientId,
      symptom: `${TEST_PREFIX}ticket`,
      assignedEngineerId: engineerId,
    });
    const engineer = appRouter.createCaller(makeCtx('engineer'));

    await expect(engineer.ticketKp.listByTicket({ ticketId })).rejects.toThrow();
    await expect(engineer.ticketKp.latest({ ticketId })).rejects.toThrow();
  });

  it('диспетчеру — как раньше', async () => {
    const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
      clientId,
      symptom: `${TEST_PREFIX}ticket`,
    });
    const dispatcher = appRouter.createCaller(makeCtx('dispatcher'));

    await expect(dispatcher.ticketKp.listByTicket({ ticketId })).resolves.toEqual([]);
    await expect(dispatcher.ticketKp.latest({ ticketId })).resolves.toBeNull();
  });
});
