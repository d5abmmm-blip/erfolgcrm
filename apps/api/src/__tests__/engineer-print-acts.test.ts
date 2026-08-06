/**
 * Печать актов инженером: реквизиты клиента для документа + правило «только свои заявки».
 *
 * Инженер должен уметь сам сформировать полноценный акт (нужны ИНН/КПП/ОГРН клиента),
 * но НЕ должен получать доступ к карточке клиента и к чужим заявкам.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import type { ResolvedTenant } from '../lib/tenant';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { assertEngineerOwnsTicket, documentClientQuery } from '../modules/tickets/service';

const TEST_PREFIX = 'TEST-PRINT-';
const OTHER_ENGINEER = '00000000-0000-0000-0000-0000000000aa';
const SOME_DISPATCHER = '00000000-0000-0000-0000-0000000000bb';

let erfolgId = '';
let erfolgClientId = '';
let erfolgEngineerId = '';
let tenant: ResolvedTenant;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  tenant = {
    id: erfolgId,
    subdomain: 'erfolg',
    displayName: 'test',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  const [e] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'engineer')).limit(1),
  );
  if (!c || !e) throw new Error('seed missing client/engineer');
  erfolgClientId = c.id;
  erfolgEngineerId = e.id;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`)),
  );
}
beforeEach(clearTestData);

async function makeTicket(assignedEngineerId: string | null): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId: erfolgClientId,
    symptom: `${TEST_PREFIX}act`,
  });
  if (assignedEngineerId) {
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(tickets).set({ assignedEngineerId }).where(eq(tickets.id, id)),
    );
  }
  return id;
}

describe('documentClient — реквизиты для акта', () => {
  it('инженер получает реквизиты по СВОЕЙ заявке', async () => {
    const ticketId = await makeTicket(erfolgEngineerId);
    const res = await documentClientQuery(
      getDb(),
      tenant,
      { role: 'engineer', userId: erfolgEngineerId },
      ticketId,
    );
    expect(res.displayName).toBeTruthy();
    // Ключевое: в ответе только поля для документа, без email/контактов целиком.
    expect(Object.keys(res).sort()).toEqual(
      [
        'contactName',
        'contactPosition',
        'displayName',
        'inn',
        'kpp',
        'legalAddress',
        'ogrn',
        'phone',
      ].sort(),
    );
  });

  it('инженер НЕ получает реквизиты по ЧУЖОЙ заявке', async () => {
    const ticketId = await makeTicket(erfolgEngineerId);
    await expect(
      documentClientQuery(getDb(), tenant, { role: 'engineer', userId: OTHER_ENGINEER }, ticketId),
    ).rejects.toThrow(/только назначенному инженеру/);
  });

  it('инженер НЕ получает реквизиты по неназначенной заявке', async () => {
    const ticketId = await makeTicket(null);
    await expect(
      documentClientQuery(
        getDb(),
        tenant,
        { role: 'engineer', userId: erfolgEngineerId },
        ticketId,
      ),
    ).rejects.toThrow(/только назначенному инженеру/);
  });

  it('диспетчер получает реквизиты по ЛЮБОЙ заявке', async () => {
    const ticketId = await makeTicket(erfolgEngineerId);
    const res = await documentClientQuery(
      getDb(),
      tenant,
      { role: 'dispatcher', userId: SOME_DISPATCHER },
      ticketId,
    );
    expect(res.displayName).toBeTruthy();
  });
});

describe('assertEngineerOwnsTicket', () => {
  it('инженер: своя — ок, чужая/неназначенная — FORBIDDEN', () => {
    expect(() =>
      assertEngineerOwnsTicket({ role: 'engineer', userId: 'u1' }, { assignedEngineerId: 'u1' }),
    ).not.toThrow();
    expect(() =>
      assertEngineerOwnsTicket({ role: 'engineer', userId: 'u1' }, { assignedEngineerId: 'u2' }),
    ).toThrow();
    expect(() =>
      assertEngineerOwnsTicket({ role: 'engineer', userId: 'u1' }, { assignedEngineerId: null }),
    ).toThrow();
  });

  it('директор и диспетчер — без ограничений', () => {
    expect(() =>
      assertEngineerOwnsTicket({ role: 'director', userId: 'u1' }, { assignedEngineerId: 'u2' }),
    ).not.toThrow();
    expect(() =>
      assertEngineerOwnsTicket({ role: 'dispatcher', userId: 'u1' }, { assignedEngineerId: null }),
    ).not.toThrow();
  });
});
