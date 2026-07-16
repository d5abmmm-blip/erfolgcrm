/**
 * tRPC роутер тендеров. RBAC: staffProcedure (директор + диспетчер — как продажи/касса,
 * инженеру раздел не нужен). Суммы — рубли на входе → копейки внутрь.
 */
import { z } from 'zod';
import { router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import * as svc from './service';

const MAX_AMOUNT_RUB = 9_999_999_999;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD');
const rubToKopecks = (rub: number): bigint => BigInt(Math.round(rub * 100));
const tenderStatus = z.enum(['won', 'in_progress', 'fulfilled', 'paid', 'cancelled']);
const periodSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

export const tendersRouter = router({
  list: staffProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(200).optional(),
          status: tenderStatus.optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
          page: z.number().int().min(1).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => svc.listTendersQuery(ctx.db, ctx.tenant, input ?? {})),

  /** Итоги за период: сумма контрактов / оплачено / ожидаем / количество. */
  summary: staffProcedure
    .input(periodSchema.optional())
    .query(({ ctx, input }) => svc.tendersSummaryQuery(ctx.db, ctx.tenant, input ?? {})),

  get: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => svc.getTenderQuery(ctx.db, ctx.tenant, input.id)),

  create: staffProcedure
    .input(
      z.object({
        clientId: z.string().uuid(),
        contractNumber: z.string().trim().min(1).max(100),
        purchaseNumber: z.string().trim().max(100).nullable().optional(),
        amountRub: z.number().min(0).max(MAX_AMOUNT_RUB),
        contractDate: isoDate,
        dueDate: isoDate.nullable().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.createTenderCmd(buildCmdCtx(ctx), {
        clientId: input.clientId,
        contractNumber: input.contractNumber,
        purchaseNumber: input.purchaseNumber ?? null,
        amountKopecks: rubToKopecks(input.amountRub),
        contractDate: input.contractDate,
        dueDate: input.dueDate ?? null,
        comment: input.comment ?? null,
      }),
    ),

  update: staffProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        clientId: z.string().uuid().optional(),
        contractNumber: z.string().trim().min(1).max(100).optional(),
        purchaseNumber: z.string().trim().max(100).nullable().optional(),
        amountRub: z.number().min(0).max(MAX_AMOUNT_RUB).optional(),
        contractDate: isoDate.optional(),
        dueDate: isoDate.nullable().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.updateTenderCmd(buildCmdCtx(ctx), input.id, {
        clientId: input.clientId,
        contractNumber: input.contractNumber,
        purchaseNumber: input.purchaseNumber,
        amountKopecks: input.amountRub !== undefined ? rubToKopecks(input.amountRub) : undefined,
        contractDate: input.contractDate,
        dueDate: input.dueDate,
        comment: input.comment,
      }),
    ),

  setStatus: staffProcedure
    .input(z.object({ id: z.string().uuid(), status: tenderStatus }))
    .mutation(({ ctx, input }) => svc.setStatusCmd(buildCmdCtx(ctx), input.id, input.status)),

  delete: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => svc.deleteTenderCmd(buildCmdCtx(ctx), input.id)),

  addPayment: staffProcedure
    .input(
      z.object({
        tenderId: z.string().uuid(),
        amountRub: z.number().positive().max(MAX_AMOUNT_RUB),
        paidOn: isoDate,
        note: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.addPaymentCmd(buildCmdCtx(ctx), {
        tenderId: input.tenderId,
        amountKopecks: rubToKopecks(input.amountRub),
        paidOn: input.paidOn,
        note: input.note ?? null,
      }),
    ),

  deletePayment: staffProcedure
    .input(z.object({ tenderId: z.string().uuid(), paymentId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      svc.deletePaymentCmd(buildCmdCtx(ctx), input.tenderId, input.paymentId),
    ),
});
