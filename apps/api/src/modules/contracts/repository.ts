/**
 * Repository contracts. Все запросы под withTenantTx (RLS на contracts FORCE).
 *
 * Жизненный цикл:
 *   create → update (status, valid_until, terms_json) → archive (soft delete).
 *   contract_number уникален среди живых записей (UNIQUE INDEX WHERE deleted_at IS NULL).
 */
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { ruIlike } from '../../lib/ru-search';
import { clients, contracts, withTenantTx, type ContractTerms, type Db } from '@erfolg/db';

export type ContractType = 'service' | 'one_time';
export type ContractStatus = 'draft' | 'active' | 'expired' | 'terminated';
export type VatRate = '0' | '5' | '10' | '20' | 'without_vat';

export interface ContractDto {
  id: string;
  clientId: string;
  clientDisplayName: string;
  contractNumber: string;
  contractDate: string;
  type: ContractType;
  vatRate: VatRate;
  status: ContractStatus;
  validFrom: string | null;
  validUntil: string | null;
  terms: ContractTerms;
  signedPdfObjectKey: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContractInput {
  clientId: string;
  contractNumber: string;
  contractDate: string;
  type?: ContractType;
  vatRate?: VatRate;
  status?: ContractStatus;
  validFrom?: string | null;
  validUntil?: string | null;
  terms?: ContractTerms;
  notes?: string | null;
}

export interface UpdateContractPatch {
  contractNumber?: string;
  contractDate?: string;
  type?: ContractType;
  vatRate?: VatRate;
  status?: ContractStatus;
  validFrom?: string | null;
  validUntil?: string | null;
  terms?: ContractTerms;
  signedPdfObjectKey?: string | null;
  notes?: string | null;
}

export interface ListOpts {
  search?: string;
  status?: ContractStatus;
  clientId?: string;
  page?: number;
}

const PAGE_SIZE = 25;

function rowToDto(row: typeof contracts.$inferSelect, clientDisplayName: string): ContractDto {
  return {
    id: row.id,
    clientId: row.clientId,
    clientDisplayName,
    contractNumber: row.contractNumber,
    contractDate: row.contractDate,
    type: row.type,
    vatRate: row.vatRate,
    status: row.status,
    validFrom: row.validFrom ?? null,
    validUntil: row.validUntil ?? null,
    terms: row.termsJson ?? {},
    signedPdfObjectKey: row.signedPdfObjectKey ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listContracts(
  db: Db,
  tenantId: string,
  opts: ListOpts = {},
): Promise<{ items: ContractDto[]; total: number }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [isNull(contracts.deletedAt)];
    if (opts.status) filters.push(eq(contracts.status, opts.status));
    if (opts.clientId) filters.push(eq(contracts.clientId, opts.clientId));
    if (opts.search) {
      const q = `%${opts.search.trim()}%`;
      filters.push(
        or(ruIlike(contracts.contractNumber, q), ruIlike(clients.displayName, q)) as SQL,
      );
    }
    const where = and(...filters);
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * PAGE_SIZE;

    const rows = await tx
      .select({ contract: contracts, clientName: clients.displayName })
      .from(contracts)
      .leftJoin(clients, eq(clients.id, contracts.clientId))
      .where(where)
      .orderBy(desc(contracts.contractDate), desc(contracts.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset);

    const totalResult = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(contracts)
      .leftJoin(clients, eq(clients.id, contracts.clientId))
      .where(where);

    return {
      items: rows.map((r) => rowToDto(r.contract, r.clientName ?? '—')),
      total: totalResult[0]?.value ?? 0,
    };
  });
}

export async function getContractById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<ContractDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ contract: contracts, clientName: clients.displayName })
      .from(contracts)
      .leftJoin(clients, eq(clients.id, contracts.clientId))
      .where(and(eq(contracts.id, id), isNull(contracts.deletedAt)))
      .limit(1);
    const first = rows[0];
    return first ? rowToDto(first.contract, first.clientName ?? '—') : null;
  });
}

export async function createContract(
  db: Db,
  tenantId: string,
  input: CreateContractInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(contracts)
      .values({
        tenantId,
        clientId: input.clientId,
        contractNumber: input.contractNumber,
        contractDate: input.contractDate,
        type: input.type ?? 'service',
        vatRate: input.vatRate ?? '5',
        status: input.status ?? 'active',
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        termsJson: input.terms ?? {},
        notes: input.notes ?? null,
      })
      .returning({ id: contracts.id });
    const row = inserted[0];
    if (!row) throw new Error('createContract: nothing returned');
    return row;
  });
}

export async function updateContract(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateContractPatch,
): Promise<ContractDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.contractNumber !== undefined) set.contractNumber = patch.contractNumber;
    if (patch.contractDate !== undefined) set.contractDate = patch.contractDate;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.vatRate !== undefined) set.vatRate = patch.vatRate;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.validFrom !== undefined) set.validFrom = patch.validFrom;
    if (patch.validUntil !== undefined) set.validUntil = patch.validUntil;
    if (patch.terms !== undefined) set.termsJson = patch.terms;
    if (patch.signedPdfObjectKey !== undefined) set.signedPdfObjectKey = patch.signedPdfObjectKey;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (Object.keys(set).length === 0) {
      return getContractById(db, tenantId, id);
    }
    const updated = await tx
      .update(contracts)
      .set(set)
      .where(and(eq(contracts.id, id), isNull(contracts.deletedAt)))
      .returning({ id: contracts.id });
    if (!updated[0]) return null;
    return getContractById(db, tenantId, id);
  });
}

export async function archiveContract(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(contracts)
      .set({ deletedAt: sql`now()`, status: 'terminated' })
      .where(and(eq(contracts.id, id), isNull(contracts.deletedAt)))
      .returning({ id: contracts.id });
    return updated.length > 0;
  });
}

/**
 * Список действующих контрактов клиента — для select'а в NewTicketPage.
 * Только status='active' и (valid_until IS NULL OR valid_until >= today).
 */
export async function listActiveByClient(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<ContractDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ contract: contracts, clientName: clients.displayName })
      .from(contracts)
      .leftJoin(clients, eq(clients.id, contracts.clientId))
      .where(
        and(
          eq(contracts.clientId, clientId),
          eq(contracts.status, 'active'),
          isNull(contracts.deletedAt),
          sql`(${contracts.validUntil} IS NULL OR ${contracts.validUntil} >= CURRENT_DATE)`,
        ),
      )
      .orderBy(desc(contracts.contractDate));
    return rows.map((r) => rowToDto(r.contract, r.clientName ?? '—'));
  });
}

/** Проверка принадлежности (нужна для tickets.contractId cross-tenant защиты). */
export async function contractExistsInTenant(
  db: Db,
  tenantId: string,
  contractId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: contracts.id })
      .from(contracts)
      .where(and(eq(contracts.id, contractId), isNull(contracts.deletedAt)))
      .limit(1);
    return rows.length > 0;
  });
}
