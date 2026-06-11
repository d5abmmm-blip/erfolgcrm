/**
 * tRPC роутер для inventory-batches.
 * RBAC: приход и списание — staffProcedure. Просмотр — engineer.
 */
import { z } from 'zod';
import { engineerProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  createBatchCmd,
  getBatchQuery,
  listBatchesQuery,
  writeoffBatchCmd,
} from './service';

const QUANTITY_REGEX = /^\d+(\.\d{1,3})?$/;
const MAX_UNIT_COST_RUB = 9_999_999_999;

export const inventoryBatchesRouter = router({
  listByItem: engineerProcedure
    .input(z.object({ itemId: z.string().uuid() }))
    .query(({ ctx, input }) => listBatchesQuery(ctx.db, ctx.tenant, input.itemId)),

  get: engineerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getBatchQuery(ctx.db, ctx.tenant, input.id)),

  create: staffProcedure
    .input(
      z.object({
        itemId: z.string().uuid(),
        batchCode: z.string().trim().max(100).nullable().optional(),
        quantity: z.string().regex(QUANTITY_REGEX, 'Количество в формате "12.345"'),
        unitCostRub: z.number().int().min(0).max(MAX_UNIT_COST_RUB),
        supplier: z.string().trim().max(300).nullable().optional(),
        receivedAt: z.coerce.date().optional(),
        expiresAt: z.coerce.date().nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      createBatchCmd(buildCmdCtx(ctx), {
        itemId: input.itemId,
        batchCode: input.batchCode ?? null,
        quantity: input.quantity,
        unitCostKopecks: BigInt(input.unitCostRub) * 100n,
        supplier: input.supplier ?? null,
        receivedAt: input.receivedAt,
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
      }),
    ),

  writeoff: staffProcedure
    .input(
      z.object({
        batchId: z.string().uuid(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      writeoffBatchCmd(buildCmdCtx(ctx), input.batchId, input.comment ?? null),
    ),
});
