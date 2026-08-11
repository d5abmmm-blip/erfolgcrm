/**
 * Service слой inventory-movements.
 * Ядро — issueToWorkOrderCmd: оборачивает FEFO-ядро + audit + перевод исключения в TRPCError.
 *
 * ⚠️ Движение и журнал действий — ОДНА транзакция. Раньше журнал писался
 * следом отдельной: его сбой превращал УДАВШЕЕСЯ списание в «ошибку на
 * сервере», а текст ещё и советовал повторить — вторая запчасть уходила со
 * склада. Теперь упал журнал → откатилось движение: «ошибка» означает
 * «ничего не произошло», повтор безопасен.
 */
import { TRPCError } from '@trpc/server';
import { withTenantTx, type Db } from '@erfolg/db';
import { writeAuditInTx } from '../../lib/audit';
import { itemExists } from '../inventory-items/repository';
import {
  NotEnoughStockError,
  issueToWorkOrderInTx as repoIssueInTx,
  listMovements as repoList,
  returnFromWorkOrderInTx as repoReturnInTx,
  type IssueResult,
  type IssueToWorkOrderInput,
  type ListMovementsOpts,
  type ReturnFromWorkOrderInput,
  type ReturnResult,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import { ticketIdForWorkOrderLine } from '../work-orders/repository';
import { assertMayEditWorkOrderOfTicket } from '../tickets/service';

export interface IssueCmdInput {
  workOrderLineId: string;
  itemId: string;
  quantity: string;
  comment?: string | null;
  /** Ключ запроса из офлайн-очереди — идемпотентный реплей (см. repository). */
  clientRequestId?: string | null;
}

/** Строка наряда принадлежит заявке, которую этому человеку можно менять. */
async function assertLineBelongsToOwnTicket(ctx: CmdCtx, workOrderLineId: string): Promise<void> {
  if (ctx.session.role !== 'engineer') return;
  const ticketId = await ticketIdForWorkOrderLine(ctx.db, ctx.tenant.id, workOrderLineId);
  if (!ticketId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Строка наряда не найдена' });
  }
  await assertMayEditWorkOrderOfTicket(ctx.db, ctx.tenant.id, ctx.session, ticketId);
}

export async function issueToWorkOrderCmd(ctx: CmdCtx, input: IssueCmdInput): Promise<IssueResult> {
  // Списание/возврат приходит с идентификатором СТРОКИ наряда, а доступ
  // решается по заявке: инженер трогает склад только в своих нарядах.
  await assertLineBelongsToOwnTicket(ctx, input.workOrderLineId);
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
    clientRequestId: input.clientRequestId ?? null,
  };
  let result: IssueResult;
  try {
    // Движение + журнал в одной транзакции (см. шапку файла).
    result = await withTenantTx(ctx.db, ctx.tenant.id, async (tx) => {
      const r = await repoIssueInTx(tx, ctx.tenant.id, repoInput);
      // Повтор реплея ничего не списал — второй записи в журнале не место.
      if (r.alreadyApplied) return r;
      await writeAuditInTx(tx, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'create',
        entityType: 'inventory_movement',
        entityId: input.workOrderLineId,
        after: {
          itemId: input.itemId,
          quantity: input.quantity,
          batches: r.consumed.length,
        },
        ip: ctx.audit.ip ?? null,
        userAgent: ctx.audit.userAgent ?? null,
      });
      return r;
    });
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
  return result;
}

export async function listMovementsQuery(db: Db, tenant: ResolvedTenant, opts: ListMovementsOpts) {
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
  // Списание/возврат приходит с идентификатором СТРОКИ наряда, а доступ
  // решается по заявке: инженер трогает склад только в своих нарядах.
  await assertLineBelongsToOwnTicket(ctx, input.workOrderLineId);
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
    // Движение + журнал в одной транзакции (см. шапку файла).
    result = await withTenantTx(ctx.db, ctx.tenant.id, async (tx) => {
      const r = await repoReturnInTx(tx, ctx.tenant.id, repoInput);
      await writeAuditInTx(tx, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'create',
        entityType: 'inventory_movement',
        entityId: input.workOrderLineId,
        after: {
          itemId: input.itemId,
          quantity: input.quantity,
          batchId: r.batchId,
          kind: 'return',
        },
        ip: ctx.audit.ip ?? null,
        userAgent: ctx.audit.userAgent ?? null,
      });
      return r;
    });
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
  return result;
}
