/**
 * Service слой contracts. Все мутации с writeAudit.
 *
 * Уникальный contract_number per tenant обеспечивается на уровне БД (UNIQUE INDEX).
 * При конфликте Postgres вернёт 23505 → ловим в catch и превращаем в TRPCError CONFLICT.
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  archiveContract,
  contractExistsInTenant,
  createContract as repoCreate,
  getContractById,
  listActiveByClient,
  listContracts,
  updateContract as repoUpdate,
  type ContractDto,
  type CreateContractInput,
  type ListOpts,
  type UpdateContractPatch,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import { pgErrorCode } from '../../lib/pg-error';
import type { CmdCtx } from '../../trpc/helpers';

function isUniqueViolation(err: unknown): boolean {
  // pgErrorCode разворачивает DrizzleQueryError (drizzle ≥0.44 кладёт оригинал в .cause)
  return pgErrorCode(err) === '23505';
}

export async function listContractsQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: ListOpts,
): Promise<{ items: ContractDto[]; total: number }> {
  return listContracts(db, tenant.id, opts);
}

export async function getContractQuery(
  db: Db,
  tenant: ResolvedTenant,
  id: string,
): Promise<ContractDto> {
  const row = await getContractById(db, tenant.id, id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Контракт не найден' });
  return row;
}

export async function listActiveByClientQuery(
  db: Db,
  tenant: ResolvedTenant,
  clientId: string,
): Promise<ContractDto[]> {
  return listActiveByClient(db, tenant.id, clientId);
}

export async function createContractCmd(
  ctx: CmdCtx,
  input: CreateContractInput,
): Promise<{ id: string }> {
  let result: { id: string };
  try {
    result = await repoCreate(ctx.db, ctx.tenant.id, input);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Контракт с таким номером уже существует',
      });
    }
    throw err;
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'contract',
    entityId: result.id,
    after: {
      clientId: input.clientId,
      contractNumber: input.contractNumber,
      type: input.type ?? 'service',
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

export async function updateContractCmd(
  ctx: CmdCtx,
  id: string,
  patch: UpdateContractPatch,
): Promise<ContractDto> {
  let updated: ContractDto | null;
  try {
    updated = await repoUpdate(ctx.db, ctx.tenant.id, id, patch);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Контракт с таким номером уже существует',
      });
    }
    throw err;
  }
  if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Контракт не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'contract',
    entityId: id,
    after: { patchKeys: Object.keys(patch) },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return updated;
}

export async function archiveContractCmd(
  ctx: CmdCtx,
  id: string,
): Promise<{ ok: true }> {
  const ok = await archiveContract(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Контракт не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'contract',
    entityId: id,
    after: { archived: true },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { ok: true };
}

/** Используется tickets/service при валидации поля contractId. */
export async function assertContractInTenant(
  db: Db,
  tenantId: string,
  contractId: string,
): Promise<void> {
  const ok = await contractExistsInTenant(db, tenantId, contractId);
  if (!ok) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Контракт не найден или принадлежит другому тенанту',
    });
  }
}
