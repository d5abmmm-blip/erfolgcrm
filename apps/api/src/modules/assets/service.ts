/**
 * Service слой для assets.
 *
 * Бизнес-инвариант: при изменении lifecycleStatus / ownerClientId / location
 * автоматически появляется asset_event соответствующего типа. Реализовано в
 * repository.updateAssetWithEvents — здесь вызывается + пишется AuditLog.
 *
 * Дополнительная защита: при смене ownerClientId явно проверяем, что новый клиент
 * принадлежит этому tenant'у (на случай если RLS-конфигурация в будущем позволит
 * read across tenants — FK constraint исполняется как owner-bypass и не защищает).
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  addNote as repoAddNote,
  clientBelongsToTenant,
  createAssetWithEvent,
  getAsset as repoGetAsset,
  listAssets as repoListAssets,
  listAssetsByClient as repoListAssetsByClient,
  listDeviceTypes as repoListDeviceTypes,
  listEvents as repoListEvents,
  listManufacturers as repoListManufacturers,
  searchAssets as repoSearchAssets,
  updateAssetWithEvents,
  type CreateAssetInput,
  type UpdateAssetInput,
} from './repository';
import { deactivateSchedulesForAsset } from '../maintenance';
import type { ResolvedTenant } from '../../lib/tenant';
import type { SessionData } from '../../lib/session';

interface AuditCtx {
  ip?: string | null;
  userAgent?: string | null;
}

export async function createAssetCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  input: CreateAssetInput,
): Promise<{ id: string }> {
  // Клиент опционален: проверяем принадлежность тенанту только если он указан.
  if (input.ownerClientId) {
    const ownerOk = await clientBelongsToTenant(db, tenant.id, input.ownerClientId);
    if (!ownerOk) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Указанный клиент не найден в этом tenant',
      });
    }
  }
  const result = await createAssetWithEvent(db, tenant.id, session.userId, input);
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'create',
    entityType: 'asset',
    entityId: result.id,
    after: {
      ownerClientId: input.ownerClientId,
      model: input.model,
      manufacturer: input.manufacturer,
      serialNumber: input.serialNumber,
    },
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
  return result;
}

export async function updateAssetCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  id: string,
  patch: UpdateAssetInput,
): Promise<void> {
  // null — снять привязку к клиенту (проверка не нужна); uuid — проверить принадлежность тенанту.
  if (patch.ownerClientId != null) {
    const ok = await clientBelongsToTenant(db, tenant.id, patch.ownerClientId);
    if (!ok) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Новый владелец не найден в этом tenant',
      });
    }
  }

  const before = await repoGetAsset(db, tenant.id, id);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Техника не найдена' });

  const { events } = await updateAssetWithEvents(db, tenant.id, session.userId, id, patch);

  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'update',
    entityType: 'asset',
    entityId: id,
    after: { patchKeys: Object.keys(patch), eventsRecorded: events.map((e) => e.type) },
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
}

export async function decommissionAssetCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  id: string,
  comment?: string,
): Promise<void> {
  const before = await repoGetAsset(db, tenant.id, id);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Техника не найдена' });
  if (before.lifecycleStatus === 'decommissioned') return;
  await updateAssetWithEvents(db, tenant.id, session.userId, id, {
    lifecycleStatus: 'decommissioned',
  });
  // Списанный аппарат больше не обслуживают — гасим его графики ТО, иначе он
  // навсегда останется в «Просрочено» и будет крутить счётчик в меню.
  const deactivated = await deactivateSchedulesForAsset(db, tenant.id, id);
  if (comment) {
    await repoAddNote(db, tenant.id, session.userId, id, comment);
  }
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'delete',
    entityType: 'asset',
    entityId: id,
    context: {
      reason: 'decommission',
      comment: comment ?? null,
      maintenanceSchedulesDeactivated: deactivated,
    },
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
}

export async function addAssetNoteCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  assetId: string,
  comment: string,
): Promise<{ id: string }> {
  const result = await repoAddNote(db, tenant.id, session.userId, assetId, comment);
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'create',
    entityType: 'asset_event',
    entityId: result.id,
    after: { type: 'note', assetId },
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
  return result;
}

export async function listAssetsQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: Parameters<typeof repoListAssets>[2],
) {
  return repoListAssets(db, tenant.id, opts);
}

export async function getAssetQuery(db: Db, tenant: ResolvedTenant, id: string) {
  const a = await repoGetAsset(db, tenant.id, id);
  if (!a) throw new TRPCError({ code: 'NOT_FOUND', message: 'Техника не найдена' });
  return a;
}

export async function searchAssetsQuery(db: Db, tenant: ResolvedTenant, q: string) {
  return repoSearchAssets(db, tenant.id, q);
}

export async function assetsByClientQuery(
  db: Db,
  tenant: ResolvedTenant,
  clientId: string,
) {
  return repoListAssetsByClient(db, tenant.id, clientId);
}

export async function assetEventsQuery(
  db: Db,
  tenant: ResolvedTenant,
  assetId: string,
  limit?: number,
) {
  return repoListEvents(db, tenant.id, assetId, limit);
}

export async function manufacturersQuery(db: Db, tenant: ResolvedTenant) {
  return repoListManufacturers(db, tenant.id);
}

export async function deviceTypesQuery(db: Db, tenant: ResolvedTenant) {
  return repoListDeviceTypes(db, tenant.id);
}
