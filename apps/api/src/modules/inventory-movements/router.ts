/**
 * tRPC роутер для inventory-movements.
 *
 * RBAC:
 * - list — engineer (видит свой склад в журнале).
 * - issueToWorkOrder — engineer (списывает запчасти на свои наряды).
 *
 * NOT_ENOUGH_STOCK → TRPCError UNPROCESSABLE_CONTENT с message='NOT_ENOUGH_STOCK'.
 * Offline runner на это смотрит и помечает как failedHard.
 */
import { z } from 'zod';
import { engineerProcedure, router } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import { issueToWorkOrderCmd, listMovementsQuery, returnFromWorkOrderCmd } from './service';

const QUANTITY_REGEX = /^\d+(\.\d{1,3})?$/;

export const inventoryMovementsRouter = router({
  list: engineerProcedure
    .input(
      z.object({
        itemId: z.string().uuid().optional(),
        kind: z.enum(['inbound', 'outbound', 'adjustment', 'writeoff']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ ctx, input }) => listMovementsQuery(ctx.db, ctx.tenant, input)),

  issueToWorkOrder: engineerProcedure
    .input(
      z.object({
        workOrderLineId: z.string().uuid(),
        itemId: z.string().uuid(),
        quantity: z.string().regex(QUANTITY_REGEX, 'Количество в формате "12.345"'),
        comment: z.string().trim().max(2000).nullable().optional(),
        /** Ключ запроса из офлайн-очереди — идемпотентный реплей списания. */
        clientRequestId: z.string().uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      issueToWorkOrderCmd(buildCmdCtx(ctx), {
        workOrderLineId: input.workOrderLineId,
        itemId: input.itemId,
        quantity: input.quantity,
        comment: input.comment ?? null,
        clientRequestId: input.clientRequestId ?? null,
      }),
    ),

  returnFromWorkOrder: engineerProcedure
    .input(
      z.object({
        workOrderLineId: z.string().uuid(),
        itemId: z.string().uuid(),
        quantity: z.string().regex(QUANTITY_REGEX, 'Количество в формате "12.345"'),
        batchId: z.string().uuid().nullable().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      returnFromWorkOrderCmd(buildCmdCtx(ctx), {
        workOrderLineId: input.workOrderLineId,
        itemId: input.itemId,
        quantity: input.quantity,
        batchId: input.batchId ?? null,
        comment: input.comment ?? null,
      }),
    ),
});
