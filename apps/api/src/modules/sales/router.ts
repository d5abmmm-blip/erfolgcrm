/**
 * tRPC роутер продаж. RBAC: staffProcedure (директор + диспетчер — продажи это
 * менеджерская зона, инженеру не нужна). Суммы — рубли на входе → копейки внутрь.
 */
import { z } from 'zod';
import { router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import * as svc from './service';

const MAX_AMOUNT_RUB = 9_999_999_999;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD');
const rubToKopecks = (rub: number): bigint => BigInt(Math.round(rub * 100));
const saleStatus = z.enum(['new', 'ordered', 'received', 'handed_over', 'cancelled']);

const itemSchema = z.object({
  name: z.string().trim().min(1).max(255),
  quantity: z.number().int().min(1).max(1_000_000),
  priceRub: z.number().min(0).max(MAX_AMOUNT_RUB),
  /** Закупочная цена за единицу (за сколько купили). Опционально. */
  costRub: z.number().min(0).max(MAX_AMOUNT_RUB).optional(),
});

const mapItems = (items: Array<z.infer<typeof itemSchema>>) =>
  items.map((it) => ({
    name: it.name,
    quantity: it.quantity,
    unitPriceKopecks: rubToKopecks(it.priceRub),
    unitCostKopecks: rubToKopecks(it.costRub ?? 0),
  }));

export const salesRouter = router({
  list: staffProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(200).optional(),
          status: saleStatus.optional(),
          page: z.number().int().min(1).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => svc.listSalesQuery(ctx.db, ctx.tenant, input ?? {})),

  get: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => svc.getSaleQuery(ctx.db, ctx.tenant, input.id)),

  create: staffProcedure
    .input(
      z.object({
        clientId: z.string().uuid(),
        supplier: z.string().trim().max(200).nullable().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
        items: z.array(itemSchema).min(1, 'Добавьте хотя бы одну позицию'),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.createSaleCmd(buildCmdCtx(ctx), {
        clientId: input.clientId,
        supplier: input.supplier ?? null,
        comment: input.comment ?? null,
        items: mapItems(input.items),
      }),
    ),

  update: staffProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        supplier: z.string().trim().max(200).nullable().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
        items: z.array(itemSchema).min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.updateSaleCmd(buildCmdCtx(ctx), input.id, {
        supplier: input.supplier,
        comment: input.comment,
        items: input.items ? mapItems(input.items) : undefined,
      }),
    ),

  setStatus: staffProcedure
    .input(z.object({ id: z.string().uuid(), status: saleStatus }))
    .mutation(({ ctx, input }) => svc.setStatusCmd(buildCmdCtx(ctx), input.id, input.status)),

  pay: staffProcedure
    .input(z.object({ id: z.string().uuid(), accountId: z.string().uuid(), paidOn: isoDate }))
    .mutation(({ ctx, input }) =>
      svc.paySaleCmd(buildCmdCtx(ctx), input.id, { accountId: input.accountId, paidOn: input.paidOn }),
    ),

  unpay: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => svc.unpaySaleCmd(buildCmdCtx(ctx), input.id)),

  delete: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => svc.deleteSaleCmd(buildCmdCtx(ctx), input.id)),
});
