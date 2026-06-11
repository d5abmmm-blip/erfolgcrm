/**
 * tRPC роутер для payments.
 * RBAC: чтение — engineer; добавление/удаление — staffProcedure.
 */
import { z } from 'zod';
import { engineerProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  addPaymentCmd,
  deletePaymentCmd,
  getTotalsQuery,
  listByTicketQuery,
} from './service';

const MAX_AMOUNT_RUB = 9_999_999_999;

export const paymentsRouter = router({
  listByTicket: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(({ ctx, input }) => listByTicketQuery(ctx.db, ctx.tenant, input.ticketId)),

  getTotals: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(({ ctx, input }) => getTotalsQuery(ctx.db, ctx.tenant, input.ticketId)),

  add: staffProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        /** Этап 8.B — опциональная привязка к счёту. Если null — «свободный» платёж. */
        invoiceId: z.string().uuid().nullable().optional(),
        amountRub: z.number().int().min(1).max(MAX_AMOUNT_RUB),
        method: z.enum(['cash', 'card', 'bank_transfer']),
        paidAt: z.coerce.date().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      addPaymentCmd(buildCmdCtx(ctx), {
        ticketId: input.ticketId,
        invoiceId: input.invoiceId ?? null,
        amountKopecks: BigInt(input.amountRub) * 100n,
        method: input.method,
        paidAt: input.paidAt ?? new Date(),
        comment: input.comment ?? null,
      }),
    ),

  delete: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deletePaymentCmd(buildCmdCtx(ctx), input.id)),
});
