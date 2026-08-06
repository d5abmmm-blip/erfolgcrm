/**
 * tRPC роутер для payments.
 * RBAC: чтение — engineer; добавление/удаление — staffProcedure.
 */
import { z } from 'zod';
import { engineerProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import { addPaymentCmd, deletePaymentCmd, getTotalsQuery, listByTicketQuery } from './service';

const MAX_AMOUNT_RUB = 9_999_999_999;

/** Рубли → копейки. Тот же приём, что в кассе, тендерах, продажах и зарплате. */
const rubToKopecks = (rub: number): bigint => BigInt(Math.round(rub * 100));

/**
 * Сумма платежа: рубли с точностью ДО КОПЕЙКИ.
 *
 * Раньше стояло `.int()`, и счёт на 1 498,50 ₽ закрыть было невозможно:
 * 1498 ₽ оставляли его вечно недоплаченным (висит в дебиторке, робот шлёт
 * клиенту напоминания об уже оплаченном счёте), а 1499 ₽ упирались в ограничение
 * базы `invoices_paid_not_exceeds_total` и показывали человеку сырую ошибку SQL.
 * Колонки в базе всегда были в копейках — резал только этот `.int()`.
 *
 * Точнее копейки не принимаем СОЗНАТЕЛЬНО. Молчаливое округление 1498.567 → 1498.57
 * при сумме у самой границы счёта ушло бы ВВЕРХ и снова упёрлось бы в то же
 * ограничение базы — то есть вернуло бы ровно ту сырую ошибку, ради которой всё это.
 * Допуск 1e-6 — на неточность двоичной дроби (0.07 * 100 = 7.000000000000001).
 */
const amountRubSchema = z
  .number({ invalid_type_error: 'Введите сумму' })
  .positive('Сумма должна быть больше 0')
  .max(MAX_AMOUNT_RUB)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
    'Сумма не может быть точнее копейки',
  );

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
        amountRub: amountRubSchema,
        method: z.enum(['cash', 'card', 'bank_transfer']),
        paidAt: z.coerce.date().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      addPaymentCmd(buildCmdCtx(ctx), {
        ticketId: input.ticketId,
        invoiceId: input.invoiceId ?? null,
        amountKopecks: rubToKopecks(input.amountRub),
        method: input.method,
        paidAt: input.paidAt ?? new Date(),
        comment: input.comment ?? null,
      }),
    ),

  delete: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deletePaymentCmd(buildCmdCtx(ctx), input.id)),
});
