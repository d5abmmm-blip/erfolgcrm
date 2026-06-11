/**
 * tRPC роутер для inventory-items.
 * RBAC: справочник правят staffProcedure (директор + диспетчер). Просмотр — engineer тоже.
 */
import { z } from 'zod';
import { engineerProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  createItemCmd,
  deleteItemCmd,
  getItemQuery,
  listItemsQuery,
  listMovementsQuery,
  updateItemCmd,
} from './service';

const QUANTITY_REGEX = /^\d+(\.\d{1,3})?$/;

const upsertSchema = z.object({
  name: z.string().trim().min(1).max(300),
  sku: z.string().trim().max(100).nullable().optional(),
  manufacturer: z.string().trim().max(200).nullable().optional(),
  unit: z.string().trim().min(1).max(20).default('шт'),
  minStock: z.string().regex(QUANTITY_REGEX, 'Минимум — число формата "0.000"').default('0'),
  category: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const inventoryItemsRouter = router({
  list: engineerProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        category: z.string().trim().max(100).nullable().optional(),
        lowStock: z.boolean().optional(),
        page: z.number().int().min(1).max(10000).optional(),
        pageSize: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(({ ctx, input }) => listItemsQuery(ctx.db, ctx.tenant, input)),

  get: engineerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getItemQuery(ctx.db, ctx.tenant, input.id)),

  movements: engineerProcedure
    .input(
      z.object({ itemId: z.string().uuid(), limit: z.number().int().min(1).max(500).optional() }),
    )
    .query(({ ctx, input }) =>
      listMovementsQuery(ctx.db, ctx.tenant, input.itemId, input.limit),
    ),

  create: staffProcedure
    .input(upsertSchema)
    .mutation(({ ctx, input }) => createItemCmd(buildCmdCtx(ctx), input)),

  update: staffProcedure
    .input(z.object({ id: z.string().uuid(), patch: upsertSchema.partial() }))
    .mutation(({ ctx, input }) => updateItemCmd(buildCmdCtx(ctx), input.id, input.patch)),

  delete: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteItemCmd(buildCmdCtx(ctx), input.id)),
});
