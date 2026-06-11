/**
 * Service слой warranties. Все мутации с writeAudit.
 * Валидация: техника принадлежит тенанту; end_date ≥ start_date (CHECK в БД, 23514 → BAD_REQUEST).
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  archiveWarranty,
  assetExistsInTenant,
  createWarranty as repoCreate,
  getWarrantyById,
  listByAsset,
  listWarranties,
  updateWarranty as repoUpdate,
  warrantyStats,
  type CreateWarrantyInput,
  type ListOpts,
  type UpdateWarrantyPatch,
  type WarrantyDto,
  type WarrantyStats,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import { pgErrorCode } from '../../lib/pg-error';
import type { CmdCtx } from '../../trpc/helpers';

function isCheckViolation(err: unknown): boolean {
  // pgErrorCode разворачивает DrizzleQueryError (drizzle ≥0.44 кладёт оригинал в .cause)
  return pgErrorCode(err) === '23514';
}

export async function listWarrantiesQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: ListOpts,
): Promise<{ items: WarrantyDto[]; total: number }> {
  return listWarranties(db, tenant.id, opts);
}

export async function getWarrantyQuery(
  db: Db,
  tenant: ResolvedTenant,
  id: string,
): Promise<WarrantyDto> {
  const row = await getWarrantyById(db, tenant.id, id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Гарантия не найдена' });
  return row;
}

export async function listByAssetQuery(
  db: Db,
  tenant: ResolvedTenant,
  assetId: string,
): Promise<WarrantyDto[]> {
  return listByAsset(db, tenant.id, assetId);
}

export async function warrantyStatsQuery(
  db: Db,
  tenant: ResolvedTenant,
): Promise<WarrantyStats> {
  return warrantyStats(db, tenant.id);
}

export async function createWarrantyCmd(
  ctx: CmdCtx,
  input: CreateWarrantyInput,
): Promise<{ id: string }> {
  const assetOk = await assetExistsInTenant(ctx.db, ctx.tenant.id, input.assetId);
  if (!assetOk) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Техника не найдена' });
  }
  let result: { id: string };
  try {
    result = await repoCreate(ctx.db, ctx.tenant.id, input);
  } catch (err) {
    if (isCheckViolation(err)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Дата окончания гарантии не может быть раньше даты начала',
      });
    }
    throw err;
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'warranty',
    entityId: result.id,
    after: { assetId: input.assetId, type: input.type ?? 'manufacturer', endDate: input.endDate },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function updateWarrantyCmd(
  ctx: CmdCtx,
  id: string,
  patch: UpdateWarrantyPatch,
): Promise<WarrantyDto> {
  let updated: WarrantyDto | null;
  try {
    updated = await repoUpdate(ctx.db, ctx.tenant.id, id, patch);
  } catch (err) {
    if (isCheckViolation(err)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Дата окончания гарантии не может быть раньше даты начала',
      });
    }
    throw err;
  }
  if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Гарантия не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'warranty',
    entityId: id,
    after: {
      patchKeys: Object.keys(patch),
      ...(patch.voided !== undefined ? { voided: patch.voided } : {}),
    },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return updated;
}

export async function archiveWarrantyCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  const ok = await archiveWarranty(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Гарантия не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'warranty',
    entityId: id,
    after: { archived: true },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}
