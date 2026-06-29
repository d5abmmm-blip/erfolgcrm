/**
 * Service слой для каталога моделей техники (asset_models).
 * Тонкие обёртки над repository + запись в AuditLog.
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  createAssetModel,
  getAssetModel as repoGetAssetModel,
  listAssetModels as repoListAssetModels,
  searchAssetModels as repoSearchAssetModels,
  updateAssetModel as repoUpdateAssetModel,
  type CreateAssetModelInput,
  type UpdateAssetModelInput,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { SessionData } from '../../lib/session';

interface AuditCtx {
  ip?: string | null;
  userAgent?: string | null;
}

export async function listAssetModelsQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: Parameters<typeof repoListAssetModels>[2],
) {
  return repoListAssetModels(db, tenant.id, opts);
}

export async function searchAssetModelsQuery(db: Db, tenant: ResolvedTenant, q: string) {
  return repoSearchAssetModels(db, tenant.id, q);
}

export async function getAssetModelQuery(db: Db, tenant: ResolvedTenant, id: string) {
  const m = await repoGetAssetModel(db, tenant.id, id);
  if (!m) throw new TRPCError({ code: 'NOT_FOUND', message: 'Модель не найдена' });
  return m;
}

export async function createAssetModelCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  input: CreateAssetModelInput,
): Promise<{ id: string; created: boolean }> {
  const result = await createAssetModel(db, tenant.id, input);
  // Аудит пишем только когда реально создали новую запись (find-or-create).
  if (result.created) {
    await writeAudit(db, tenant.id, {
      userId: session.userId,
      action: 'create',
      entityType: 'asset_model',
      entityId: result.id,
      after: { manufacturer: input.manufacturer ?? null, model: input.model },
      ip: audit.ip ?? null,
      userAgent: audit.userAgent ?? null,
    });
  }
  return result;
}

export async function updateAssetModelCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  id: string,
  patch: UpdateAssetModelInput,
): Promise<void> {
  const ok = await repoUpdateAssetModel(db, tenant.id, id, patch);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Модель не найдена' });
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'update',
    entityType: 'asset_model',
    entityId: id,
    after: { patchKeys: Object.keys(patch) },
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
}
