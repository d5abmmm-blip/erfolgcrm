/**
 * Service слой inventory-batches.
 * Все мутации сопровождаются writeAudit (152-ФЗ).
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import { itemExists } from '../inventory-items/repository';
import {
  createBatch as repoCreate,
  getBatch as repoGet,
  listBatchesByItem as repoListByItem,
  writeoffBatch as repoWriteoff,
  type CreateBatchInput,
  type InventoryBatchDto,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

export async function listBatchesQuery(
  db: Db,
  tenant: ResolvedTenant,
  itemId: string,
): Promise<InventoryBatchDto[]> {
  return repoListByItem(db, tenant.id, itemId);
}

export async function getBatchQuery(
  db: Db,
  tenant: ResolvedTenant,
  batchId: string,
): Promise<InventoryBatchDto | null> {
  return repoGet(db, tenant.id, batchId);
}

export async function createBatchCmd(
  ctx: CmdCtx,
  input: CreateBatchInput,
): Promise<{ id: string }> {
  if (!(await itemExists(ctx.db, ctx.tenant.id, input.itemId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Товар не найден в этом тенанте' });
  }
  const result = await repoCreate(ctx.db, ctx.tenant.id, ctx.session.userId, input);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'inventory_batch',
    entityId: result.id,
    after: {
      itemId: input.itemId,
      quantity: input.quantity,
      unitCostKopecks: input.unitCostKopecks.toString(),
      hasExpiry: input.expiresAt !== undefined && input.expiresAt !== null,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

export async function writeoffBatchCmd(
  ctx: CmdCtx,
  batchId: string,
  comment: string | null,
): Promise<{ writtenOff: string }> {
  const result = await repoWriteoff(ctx.db, ctx.tenant.id, ctx.session.userId, batchId, comment);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'inventory_batch',
    entityId: batchId,
    after: { writtenOff: result.writtenOff },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}
