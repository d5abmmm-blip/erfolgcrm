/**
 * Контракт у госучреждения — ПРЕДУПРЕЖДЕНИЕ, а не запрет (решение владельца 2026-07-23).
 *
 * ЧТО БЫЛО. `ensureContractRequirement` бросал BAD_REQUEST, если у клиента
 * `subtype='budget'` и в заявке не указан контракт. Правило поставили со ссылкой
 * на 44-ФЗ, но на боевых данных оно закрывало работу:
 *   • госучреждений в базе 122, договоров заведено 0 (ни одного);
 *   • их заявок 4589 = 76,5 % всей работы, и ВСЕ без контракта — они приехали
 *     из старой программы и прекрасно живут;
 *   • сам контракт дальше нигде не используется — ни в счетах, ни в документах.
 * То есть менеджер не мог завести заявку ни одному госучреждению.
 *
 * ЧТО СТАЛО. Заявка создаётся и сохраняется, а в ответе приходит `contractWarning` —
 * его показывают плашкой, как давно сделано с аттестацией инженера.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createClient } from '../modules/clients/repository';
import { createContract } from '../modules/contracts/repository';
import { createTicketCmd, updateTicketCmd } from '../modules/tickets/service';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TESTBUDGET-';

let erfolgId = '';
let budgetClientId = '';
let commercialClientId = '';
let staffUserId = '';
let seq = 0;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [u] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).limit(1),
  );
  if (!u) throw new Error('seed missing user');
  staffUserId = u.id;

  budgetClientId = await makeClient('budget');
  commercialClientId = await makeClient('commercial');
});

async function makeClient(subtype: 'budget' | 'commercial'): Promise<string> {
  seq += 1;
  const { id } = await createClient(getDb(), erfolgId, {
    type: 'legal',
    subtype,
    displayName: `${TEST_PREFIX}${subtype}-${Date.now()}-${seq}`,
  });
  return id;
}

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

function makeCtx() {
  const tenant: ResolvedTenant = {
    id: erfolgId,
    subdomain: 'erfolg',
    displayName: 'erfolg',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
  const session: SessionData = {
    tenantId: erfolgId,
    userId: staffUserId,
    username: 'test',
    role: 'dispatcher',
    fullName: 'Тест',
    expiresAt: Date.now() + 60_000,
  };
  return { db: getDb(), tenant, session, audit: { ip: null, userAgent: null } };
}

describe('госучреждение без контракта: работа НЕ встаёт', () => {
  it('заявку можно создать — раньше здесь была ошибка', async () => {
    const res = await createTicketCmd(makeCtx(), {
      clientId: budgetClientId,
      symptom: `${TEST_PREFIX}без контракта`,
    });
    expect(res.ticketNumber).toMatch(/^T-\d{4}-\d{6}$/);
  });

  it('в ответе приходит предупреждение — менеджер видит, что контракта нет', async () => {
    const res = await createTicketCmd(makeCtx(), {
      clientId: budgetClientId,
      symptom: `${TEST_PREFIX}предупреждение`,
    });
    expect(res.contractWarning).toBeTruthy();
    expect(res.contractWarning).toContain('контракт');
  });

  it('заявку можно сохранить, убрав контракт', async () => {
    const { id: contractId } = await createContract(getDb(), erfolgId, {
      clientId: budgetClientId,
      contractNumber: `${TEST_PREFIX}${Date.now()}`,
      contractDate: '2026-01-15',
    });
    const created = await createTicketCmd(makeCtx(), {
      clientId: budgetClientId,
      contractId,
      symptom: `${TEST_PREFIX}снимаем контракт`,
    });

    const res = await updateTicketCmd(makeCtx(), created.id, { contractId: null });

    expect(res.contractWarning).toBeTruthy();
  });
});

describe('предупреждение появляется только когда уместно', () => {
  it('у госучреждения С контрактом предупреждения нет', async () => {
    const { id: contractId } = await createContract(getDb(), erfolgId, {
      clientId: budgetClientId,
      contractNumber: `${TEST_PREFIX}ok-${Date.now()}`,
      contractDate: '2026-01-15',
    });
    const res = await createTicketCmd(makeCtx(), {
      clientId: budgetClientId,
      contractId,
      symptom: `${TEST_PREFIX}с контрактом`,
    });
    expect(res.contractWarning).toBeNull();
  });

  it('у коммерческого клиента без контракта предупреждения нет', async () => {
    // Иначе плашка висела бы почти на каждой заявке и её перестали бы замечать.
    const res = await createTicketCmd(makeCtx(), {
      clientId: commercialClientId,
      symptom: `${TEST_PREFIX}коммерческий`,
    });
    expect(res.contractWarning).toBeNull();
  });
});
