/**
 * Service слой inventory-items.
 *
 * Удаление item: запрещено если есть movements (409). Сохраняем историю.
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  createItem as repoCreate,
  deleteItem as repoDelete,
  getItem as repoGet,
  hasMovements,
  listItems as repoList,
  listMovementsForItem,
  updateItem as repoUpdate,
  type InventoryItemDto,
  type ListItemsOpts,
  type UpsertItemInput,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

export async function listItemsQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: ListItemsOpts,
): Promise<{ items: InventoryItemDto[]; total: number }> {
  return repoList(db, tenant.id, opts);
}

export async function getItemQuery(
  db: Db,
  tenant: ResolvedTenant,
  itemId: string,
): Promise<InventoryItemDto | null> {
  return repoGet(db, tenant.id, itemId);
}

export async function createItemCmd(ctx: CmdCtx, input: UpsertItemInput): Promise<{ id: string }> {
  const result = await repoCreate(ctx.db, ctx.tenant.id, input);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'inventory_item',
    entityId: result.id,
    after: { name: input.name, unit: input.unit, category: input.category ?? null },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

export async function updateItemCmd(
  ctx: CmdCtx,
  itemId: string,
  patch: Partial<UpsertItemInput>,
): Promise<void> {
  await repoUpdate(ctx.db, ctx.tenant.id, itemId, patch);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'inventory_item',
    entityId: itemId,
    after: { patchKeys: Object.keys(patch) },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}

export async function deleteItemCmd(ctx: CmdCtx, itemId: string): Promise<void> {
  if (await hasMovements(ctx.db, ctx.tenant.id, itemId)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'Нельзя удалить позицию, по которой есть движения. Деактивируйте через смену категории.',
    });
  }
  await repoDelete(ctx.db, ctx.tenant.id, itemId);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'inventory_item',
    entityId: itemId,
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}

export async function listMovementsQuery(
  db: Db,
  tenant: ResolvedTenant,
  itemId: string,
  limit?: number,
) {
  return listMovementsForItem(db, tenant.id, itemId, limit);
}
