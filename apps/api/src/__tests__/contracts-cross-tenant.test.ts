/**
 * Этап 6.B — изоляция contracts между тенантами + cross-tenant tickets.contract_id.
 *
 * Проверяем:
 *   1. listContracts чужого tenant'а возвращает пустой результат (RLS).
 *   2. getContractById по чужому id возвращает null.
 *   3. archiveContract по чужому id возвращает false.
 *   4. contractExistsInTenant отказывает для чужого id.
 *   5. attachments.verifyReferenceBelongsToTenant: case 'contract' уважает RLS.
 *   6. createTicket с contract_id из другого tenant'а — TRPCError BAD_REQUEST.
 *   7. ensureContractRequirement бросает для бюджетников без контракта.
 *   8. UNIQUE (tenant_id, contract_number) WHERE deleted_at IS NULL — два tenant'а могут иметь
 *      одинаковый номер; внутри одного tenant'а второй активный с тем же номером падает.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import {
  attachments,
  clients,
  contracts,
  getDb,
  tickets,
  users,
  withTenantTx,
} from '@erfolg/db';
import { TRPCError } from '@trpc/server';
import { ensureSeed } from './setup';
import {
  archiveContract,
  contractExistsInTenant,
  createContract,
  getContractById,
  listActiveByClient,
  listContracts,
} from '../modules/contracts/repository';
import { verifyReferenceBelongsToTenant } from '../modules/attachments/repository';
import { createTicketCmd } from '../modules/tickets/service';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let demoId = '';
let erfolgCommercialClientId = '';
let erfolgBudgetClientId = '';
let demoClientId = '';
let erfolgDispatcherId = '';
let demoDispatcherId = '';

const TEST_PREFIX = 'TEST-CONTR-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  // erfolg может уже иметь budget-клиента в seed; если нет — создадим тестовый.
  const erfolgBudget = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.type, 'legal'), eq(clients.subtype, 'budget')))
      .limit(1),
  );
  if (erfolgBudget[0]) {
    erfolgBudgetClientId = erfolgBudget[0].id;
  } else {
    const [created] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .insert(clients)
        .values({
          tenantId: erfolgId,
          type: 'legal',
          subtype: 'budget',
          displayName: `${TEST_PREFIX}Budget client`,
          inn: '7700000001',
          status: 'active',
        })
        .returning({ id: clients.id }),
    );
    if (!created) throw new Error('failed to create budget client');
    erfolgBudgetClientId = created.id;
  }

  const erfolgCommercial = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.type, 'legal'), eq(clients.subtype, 'commercial')))
      .limit(1),
  );
  if (erfolgCommercial[0]) {
    erfolgCommercialClientId = erfolgCommercial[0].id;
  } else {
    const [created] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .insert(clients)
        .values({
          tenantId: erfolgId,
          type: 'legal',
          subtype: 'commercial',
          displayName: `${TEST_PREFIX}Commercial client`,
          inn: '7700000002',
          status: 'active',
        })
        .returning({ id: clients.id }),
    );
    if (!created) throw new Error('failed to create commercial client');
    erfolgCommercialClientId = created.id;
  }

  const [dc] = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!dc) throw new Error('seed missing demo client');
  demoClientId = dc.id;

  const [eu] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'dispatcher'))
      .limit(1),
  );
  const [du] = await withTenantTx(getDb(), demoId, (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'dispatcher'))
      .limit(1),
  );
  if (!eu || !du) throw new Error('seed missing dispatcher users');
  erfolgDispatcherId = eu.id;
  demoDispatcherId = du.id;
});

async function clearTestData(): Promise<void> {
  // Чистим перед каждым тестом — атрибуты уникальны через TEST_PREFIX в notes.
  for (const t of [erfolgId, demoId]) {
    await withTenantTx(getDb(), t, async (tx) => {
      await tx.delete(attachments).where(like(attachments.objectKey, `tenants/%/${TEST_PREFIX}%`));
      // Тикеты с TEST_PREFIX в symptom (createTicket нижеставит туда префикс).
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
      await tx
        .delete(contracts)
        .where(like(contracts.contractNumber, `${TEST_PREFIX}%`));
    });
  }
}

function makeCmdCtx(tenantId: string, userId: string) {
  const tenant: ResolvedTenant = {
    id: tenantId,
    subdomain: 'test',
    displayName: 'test',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
  const session: SessionData = {
    tenantId,
    userId,
    username: 'test',
    role: 'dispatcher',
    fullName: 'Test Dispatcher',
    expiresAt: Date.now() + 60_000,
  };
  return {
    db: getDb(),
    tenant,
    session,
    audit: { ip: null, userAgent: null },
  };
}

describe('contracts cross-tenant изоляция', () => {
  beforeEach(async () => {
    await clearTestData();
  });

  it('listContracts другого tenant: пустой', async () => {
    const { id } = await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}001`,
      contractDate: '2026-01-15',
    });
    expect(id).toBeTruthy();

    const erfolgList = await listContracts(getDb(), erfolgId);
    const demoList = await listContracts(getDb(), demoId);
    expect(erfolgList.items.some((c) => c.contractNumber === `${TEST_PREFIX}001`)).toBe(true);
    expect(demoList.items.some((c) => c.contractNumber === `${TEST_PREFIX}001`)).toBe(false);
  });

  it('getContractById по чужому id возвращает null', async () => {
    const { id } = await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}002`,
      contractDate: '2026-01-15',
    });
    const fromOther = await getContractById(getDb(), demoId, id);
    expect(fromOther).toBeNull();
    const fromSelf = await getContractById(getDb(), erfolgId, id);
    expect(fromSelf?.id).toBe(id);
  });

  it('archiveContract по чужому id возвращает false', async () => {
    const { id } = await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}003`,
      contractDate: '2026-01-15',
    });
    const failed = await archiveContract(getDb(), demoId, id);
    expect(failed).toBe(false);
    const succeeded = await archiveContract(getDb(), erfolgId, id);
    expect(succeeded).toBe(true);
  });

  it('contractExistsInTenant отказывает для чужого', async () => {
    const { id } = await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}004`,
      contractDate: '2026-01-15',
    });
    expect(await contractExistsInTenant(getDb(), erfolgId, id)).toBe(true);
    expect(await contractExistsInTenant(getDb(), demoId, id)).toBe(false);
  });

  it('attachments.verifyReferenceBelongsToTenant respects RLS for contract', async () => {
    const { id } = await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}005`,
      contractDate: '2026-01-15',
    });
    const allowedSelf = await verifyReferenceBelongsToTenant(getDb(), erfolgId, 'contract', id);
    const allowedOther = await verifyReferenceBelongsToTenant(getDb(), demoId, 'contract', id);
    expect(allowedSelf).toBe(true);
    expect(allowedOther).toBe(false);
  });

  it('createTicket с contractId из другого tenant отлетает с BAD_REQUEST', async () => {
    const { id: erfolgContractId } = await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}006`,
      contractDate: '2026-01-15',
    });
    // Пробуем создать тикет в demo, ссылаясь на контракт erfolg.
    const ctx = makeCmdCtx(demoId, demoDispatcherId);
    await expect(
      createTicketCmd(ctx, {
        clientId: demoClientId,
        contractId: erfolgContractId,
        symptom: `${TEST_PREFIX}cross`,
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('budget client требует contract — без contractId выбрасывает BAD_REQUEST', async () => {
    const ctx = makeCmdCtx(erfolgId, erfolgDispatcherId);
    await expect(
      createTicketCmd(ctx, {
        clientId: erfolgBudgetClientId,
        symptom: `${TEST_PREFIX}budget-fail`,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('бюджетной'),
    });
  });

  it('budget client с активным contract проходит', async () => {
    const { id: contractId } = await createContract(getDb(), erfolgId, {
      clientId: erfolgBudgetClientId,
      contractNumber: `${TEST_PREFIX}008`,
      contractDate: '2026-01-15',
    });
    const ctx = makeCmdCtx(erfolgId, erfolgDispatcherId);
    const result = await createTicketCmd(ctx, {
      clientId: erfolgBudgetClientId,
      contractId,
      symptom: `${TEST_PREFIX}budget-ok`,
    });
    expect(result.ticketNumber).toMatch(/^T-\d{4}-\d{6}$/);
  });

  it('UNIQUE по (tenant, contract_number) среди живых, разные tenants не пересекаются', async () => {
    await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}DUP`,
      contractDate: '2026-01-15',
    });
    // Тот же номер в demo — допустимо.
    await createContract(getDb(), demoId, {
      clientId: demoClientId,
      contractNumber: `${TEST_PREFIX}DUP`,
      contractDate: '2026-01-15',
    });
    // А вот второй активный с тем же номером в erfolg должен упасть на UNIQUE.
    await expect(
      createContract(getDb(), erfolgId, {
        clientId: erfolgCommercialClientId,
        contractNumber: `${TEST_PREFIX}DUP`,
        contractDate: '2026-02-15',
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('listActiveByClient: только active и валидные по дате', async () => {
    // Активный с открытой датой
    await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}A1`,
      contractDate: '2026-01-15',
      validUntil: null,
    });
    // Активный с прошедшим validUntil — не должен попасть
    await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}A2`,
      contractDate: '2024-01-15',
      validUntil: '2024-12-31',
    });
    // Черновик
    await createContract(getDb(), erfolgId, {
      clientId: erfolgCommercialClientId,
      contractNumber: `${TEST_PREFIX}A3`,
      contractDate: '2026-01-15',
      status: 'draft',
    });

    const active = await listActiveByClient(getDb(), erfolgId, erfolgCommercialClientId);
    const numbers = active.map((c) => c.contractNumber).filter((n) => n.startsWith(TEST_PREFIX));
    expect(numbers).toContain(`${TEST_PREFIX}A1`);
    expect(numbers).not.toContain(`${TEST_PREFIX}A2`);
    expect(numbers).not.toContain(`${TEST_PREFIX}A3`);
  });
});
