/**
 * Проактивный AI — устойчивость без LLM.
 *
 * В тест-окружении LLM не настроен (env LLM_* пусты, llm_configs пуст) → phraseWithLlm
 * возвращает null. Проверяем, что детерминированные ДАННЫЕ всё равно считаются и отдаются:
 *   1. dailySummary отдаёт data (числа) и text=null, ничего не бросает.
 *   2. explainTicketBlock отдаёт facts (статус/причина/таймлайн) и text=null.
 *   3. explainTicketBlock для несуществующей заявки → null.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-AIPRO-';

let erfolgId = '';
let primaryClientId = '';
let dispatcherId = '';
let engineerId = '';
let directorId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  dispatcherId = usrs.find((u) => u.role === 'dispatcher')?.id ?? '';
  engineerId = usrs.find((u) => u.role === 'engineer')?.id ?? '';
  directorId = usrs.find((u) => u.role === 'director')?.id ?? dispatcherId;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}
beforeEach(clearTestData);

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

describe('Проактивный AI: dailySummary', () => {
  it('отдаёт данные и text=null без настроенного LLM', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const res = await caller.aiAssistant.dailySummary();
    expect(res.text).toBeNull();
    expect(typeof res.data.activeTotal).toBe('number');
    expect(typeof res.data.stuckCount).toBe('number');
    expect(typeof res.data.readyCount).toBe('number');
    expect(Array.isArray(res.data.topStuck)).toBe(true);
    expect(typeof res.date).toBe('string');
  });
});

describe('Проактивный AI: explainTicketBlock', () => {
  it('отдаёт факты (статус/причина/таймлайн) и text=null', async () => {
    const { id } = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}explain`,
    });
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    await caller.tickets.setBlockedReason({ ticketId: id, reason: 'waiting_payment', note: null });

    const res = await caller.aiAssistant.explainTicketBlock({ ticketId: id });
    expect(res).not.toBeNull();
    expect(res?.text).toBeNull();
    expect(res?.facts.status).toBe('Принята');
    expect(res?.facts.reason).toBe('ждём оплату');
    expect(res?.facts.timeline.length).toBeGreaterThan(0);
    expect(res?.facts.timeline[0]).toBe('Заявка создана');
  });

  it('для несуществующей заявки → null', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const res = await caller.aiAssistant.explainTicketBlock({
      ticketId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res).toBeNull();
  });
});
