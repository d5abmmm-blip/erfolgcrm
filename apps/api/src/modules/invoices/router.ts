/**
 * tRPC роутер invoices.
 *
 * Чтение — engineerProcedure (инженер видит счета своих заявок).
 * Создание/issue/cancel/update/delete — staffProcedure (директор + диспетчер).
 */
import { z } from 'zod';
import { engineerProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  cancelCmd,
  createDraftCmd,
  deleteDraftCmd,
  getByIdQuery,
  issueCmd,
  listByClientQuery,
  listByTicketQuery,
  listForTenantQuery,
  receivablesQuery,
  sendReminderCmd,
  updateDraftCmd,
} from './service';

const invoiceStatusEnum = z.enum([
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'cancelled',
]);
const vatRateEnum = z.enum(['0', '5', '10', '20', 'without_vat']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата должна быть в формате YYYY-MM-DD');

export const invoicesRouter = router({
  getById: engineerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getByIdQuery(ctx.db, ctx.tenant, input.id)),

  listByTicket: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(({ ctx, input }) => listByTicketQuery(ctx.db, ctx.tenant, input.ticketId)),

  listByClient: engineerProcedure
    .input(
      z.object({
        clientId: z.string().uuid(),
        status: invoiceStatusEnum.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      listByClientQuery(ctx.db, ctx.tenant, input.clientId, {
        status: input.status,
        limit: input.limit,
      }),
    ),

  listForTenant: engineerProcedure
    .input(
      z.object({
        status: invoiceStatusEnum.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        page: z.number().int().min(1).optional(),
      }).optional(),
    )
    .query(({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const page = input?.page ?? 1;
      const offset = (page - 1) * limit;
      return listForTenantQuery(ctx.db, ctx.tenant, {
        status: input?.status,
        limit,
        offset,
      });
    }),

  /** Отчёт «Дебиторка»: кто должен + разбивка по срокам + сводка. Staff (директор+диспетчер). */
  receivables: staffProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).optional() }).optional())
    .query(({ ctx, input }) => receivablesQuery(ctx.db, ctx.tenant, input?.limit)),

  /** Ручное напоминание клиенту по его просроченным счетам (кнопка «Напомнить»). */
  sendReminder: staffProcedure
    .input(z.object({ clientId: z.string().uuid() }))
    .mutation(({ ctx, input }) => sendReminderCmd(buildCmdCtx(ctx), input.clientId)),

  createDraft: staffProcedure
    .input(
      z.object({
        workOrderId: z.string().uuid(),
        dueDays: z.number().int().min(0).max(365).optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      createDraftCmd(buildCmdCtx(ctx), {
        workOrderId: input.workOrderId,
        dueDays: input.dueDays,
        notes: input.notes ?? null,
      }),
    ),

  updateDraft: staffProcedure
    .input(
      z.object({
        invoiceId: z.string().uuid(),
        dueDate: isoDate.optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
        vatRate: vatRateEnum.optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateDraftCmd(buildCmdCtx(ctx), input)),

  issue: staffProcedure
    .input(
      z.object({
        invoiceId: z.string().uuid(),
        dueDate: isoDate.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      issueCmd(buildCmdCtx(ctx), input.invoiceId, { dueDate: input.dueDate }),
    ),

  cancel: staffProcedure
    .input(
      z.object({
        invoiceId: z.string().uuid(),
        reason: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      cancelCmd(buildCmdCtx(ctx), input.invoiceId, input.reason ?? null),
    ),

  deleteDraft: staffProcedure
    .input(z.object({ invoiceId: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteDraftCmd(buildCmdCtx(ctx), input.invoiceId)),
});
