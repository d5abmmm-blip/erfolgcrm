/**
 * tRPC роутер для work_orders / work_order_lines.
 *
 * RBAC:
 * - get / ensure / upsertLine / deleteLine / updateHeader (без vatRate) — engineerProcedure.
 *   Инженер должен иметь возможность создавать наряд по своей заявке и заполнять диагноз.
 * - setVatRate — staffProcedure (директор + диспетчер). Ставка НДС влияет на счёт клиенту.
 */
import { z } from 'zod';
import { VatRate, WorkOrderLineType } from '@erfolg/shared';
import { router, engineerProcedure, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  composeEngineerNotesQuery,
  deleteLineCmd,
  draftRepairDescriptionQuery,
  ensureWorkOrderCmd,
  getWorkOrderByTicketQuery,
  setVatRateCmd,
  updateHeaderCmd,
  upsertLineCmd,
} from './service';

const QUANTITY_REGEX = /^\d+(\.\d{1,3})?$/;
/** До 99 999 999.99 руб (≈100 млн ₽) на строку — с запасом для дорогой техники. */
const MAX_UNIT_PRICE_RUB = 9_999_999_999;

const lineUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  lineType: WorkOrderLineType,
  name: z.string().trim().min(1).max(500),
  unit: z.string().trim().max(20).default('шт'),
  quantity: z.string().regex(QUANTITY_REGEX, 'Количество в формате "12.345"'),
  unitPriceRub: z.number().int().min(0).max(MAX_UNIT_PRICE_RUB),
  engineerId: z.string().uuid().nullable().optional(),
  comment: z.string().trim().max(2000).nullable().optional(),
  orderIdx: z.number().int().min(0).max(10000).optional(),
});

const updateHeaderSchema = z
  .object({
    diagnosis: z.string().trim().max(5000).nullable().optional(),
    repairDescription: z.string().trim().max(5000).nullable().optional(),
    recommendation: z.string().trim().max(5000).nullable().optional(),
    /** Исходник инженера, написанный своими словами (см. compose-notes.ts). */
    engineerNotes: z.string().trim().max(5000).nullable().optional(),
    engineerId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const workOrdersRouter = router({
  getByTicket: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(({ ctx, input }) => getWorkOrderByTicketQuery(ctx.db, ctx.tenant, input.ticketId)),

  ensure: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .mutation(({ ctx, input }) => ensureWorkOrderCmd(buildCmdCtx(ctx), input.ticketId)),

  upsertLine: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid(), line: lineUpsertSchema }))
    .mutation(({ ctx, input }) =>
      upsertLineCmd(buildCmdCtx(ctx), {
        ticketId: input.ticketId,
        lineId: input.line.id ?? null,
        lineType: input.line.lineType,
        name: input.line.name,
        unit: input.line.unit,
        quantity: input.line.quantity,
        unitPriceKopecks: BigInt(input.line.unitPriceRub) * 100n,
        // Без `?? null`: «поле не прислали» должно отличаться от «сбросить в
        // пусто», иначе правка строки из веба затирает инженера и комментарий.
        engineerId: input.line.engineerId,
        comment: input.line.comment,
        orderIdx: input.line.orderIdx,
      }),
    ),

  deleteLine: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid(), lineId: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteLineCmd(buildCmdCtx(ctx), input.ticketId, input.lineId)),

  updateHeader: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid(), patch: updateHeaderSchema }))
    .mutation(({ ctx, input }) => updateHeaderCmd(buildCmdCtx(ctx), input.ticketId, input.patch)),

  setVatRate: staffProcedure
    .input(z.object({ ticketId: z.string().uuid(), vatRate: VatRate }))
    .mutation(({ ctx, input }) => setVatRateCmd(buildCmdCtx(ctx), input.ticketId, input.vatRate)),

  /** Фича №13 — ИИ-черновик текста «Выполненные работы» из строк наряда (engineer). */
  draftRepairDescription: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .mutation(({ ctx, input }) => draftRepairDescriptionQuery(ctx.db, ctx.tenant, input.ticketId)),

  /**
   * Разложить написанное инженером своими словами на «Диагноз» и «Описание
   * ремонта». Мутация, хотя ничего не пишет: это действие по кнопке, и ему
   * нужен `networkMode: 'always'` — иначе без связи запрос не упадёт, а
   * повиснет на паузе (ровно так намертво зависал сканер, #112).
   */
  composeFromNotes: engineerProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        notes: z.string().trim().max(5000),
      }),
    )
    .mutation(({ ctx, input }) =>
      composeEngineerNotesQuery(buildCmdCtx(ctx), input.ticketId, input.notes),
    ),
});
