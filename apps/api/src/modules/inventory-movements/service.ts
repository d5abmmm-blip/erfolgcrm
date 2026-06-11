/**
 * Service слой inventory-movements.
 * Ядро — issueToWorkOrderCmd: оборачивает FEFO-ядро + audit + перевод исключения в TRPCError.
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import { itemExists } from '../inventory-items/repository';
import {
  NotEnoughStockError,
  issueToWorkOrder as repoIssue,
  listMovements as repoList,
  returnFromWorkOrder as repoReturn,
  type IssueResult,
  type IssueToWorkOrderInput,
  type ListMovementsOpts,
  type ReturnFromWorkOrderInput,
  type ReturnResult,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

export interface IssueCmdInput {
  workOrderLineId: string;
  itemId: string;
  quantity: string;
  comment?: string | null;
}

export async function issueToWorkOrderCmd(
  ctx: CmdCtx,
  input: IssueCmdInput,
): Promise<IssueResult> {
  if (!(await itemExists(ctx.db, ctx.tenant.id, input.itemId))) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Товар не найден в этом тенанте',
    });
  }
  const repoInput: IssueToWorkOrderInput = {
    workOrderLineId: input.workOrderLineId,
    itemId: input.itemId,
    quantity: input.quantity,
    userId: ctx.session.userId,
    comment: input.comment ?? null,
  };
  let result: IssueResult;
  try {
    result = await repoIssue(ctx.db, ctx.tenant.id, repoInput);
  } catch (err) {
    if (err instanceof NotEnoughStockError) {
      throw new TRPCError({
        code: 'UNPROCESSABLE_CONTENT',
        message: 'NOT_ENOUGH_STOCK',
        cause: err,
      });
    }
    throw err;
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'inventory_movement',
    entityId: input.workOrderLineId,
    after: {
      itemId: input.itemId,
      quantity: input.quantity,
      batches: result.consumed.length,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

export async function listMovementsQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: ListMovementsOpts,
) {
  return repoList(db, tenant.id, opts);
}

export interface ReturnCmdInput {
  workOrderLineId: string;
  itemId: string;
  quantity: string;
  batchId?: string | null;
  comment?: string | null;
}

export async function returnFromWorkOrderCmd(
  ctx: CmdCtx,
  input: ReturnCmdInput,
): Promise<ReturnResult> {
  if (!(await itemExists(ctx.db, ctx.tenant.id, input.itemId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Товар не найден в этом тенанте' });
  }
  const repoInput: ReturnFromWorkOrderInput = {
    workOrderLineId: input.workOrderLineId,
    itemId: input.itemId,
    quantity: input.quantity,
    batchId: input.batchId ?? null,
    userId: ctx.session.userId,
    comment: input.comment ?? null,
  };
  let result: ReturnResult;
  try {
    result = await repoReturn(ctx.db, ctx.tenant.id, repoInput);
  } catch (err) {
    if (err instanceof Error && err.message === 'RETURN_EXCEEDS_BATCH_INITIAL') {
      throw new TRPCError({
        code: 'UNPROCESSABLE_CONTENT',
        message: 'RETURN_EXCEEDS_BATCH_INITIAL',
        cause: err,
      });
    }
    throw err;
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'inventory_movement',
    entityId: input.workOrderLineId,
    after: {
      itemId: input.itemId,
      quantity: input.quantity,
      batchId: result.batchId,
      kind: 'return',
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}
