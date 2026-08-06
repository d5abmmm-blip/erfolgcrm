/**
 * tRPC роутер для шаблонов заявок.
 *
 * RBAC:
 *   - list / get — staffProcedure (директор + диспетчер). Инженеру шаблоны не нужны
 *     — он работает с уже применёнными работами в наряде.
 *   - create / update / archive / unarchive — staffProcedure.
 *   - apply — staffProcedure (применяется при оформлении заявки/наряда).
 *
 * Валидация:
 *   - имя обязательно, max 200.
 *   - description опц., max 5000.
 *   - default_estimated_minutes ∈ [1; 720].
 *   - lines: max 100, каждая — quantity matches /^\d+(\.\d{1,3})?$/, цена ≥ 0.
 */
import { z } from 'zod';
import { RepairType, TicketPriority, WorkOrderLineType } from '@erfolg/shared';
import { router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  applyTemplateCmd,
  archiveTemplateCmd,
  createTemplateCmd,
  getTemplateQuery,
  listTemplatesQuery,
  unarchiveTemplateCmd,
  updateTemplateCmd,
} from './service';

const QUANTITY_REGEX = /^\d+(\.\d{1,3})?$/;
const MAX_UNIT_PRICE_RUB = 9_999_999_999;

const templateLineSchema = z.object({
  lineType: WorkOrderLineType,
  name: z.string().trim().min(1, 'Название обязательно').max(500),
  unit: z.string().trim().min(1).max(20).default('шт'),
  quantity: z.string().regex(QUANTITY_REGEX, 'Количество в формате «12.345»'),
  unitPriceRub: z.number().int('Цена в целых рублях').min(0).max(MAX_UNIT_PRICE_RUB).nullable(),
  inventoryItemId: z.string().uuid().nullable(),
});

const createInputSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(200),
  description: z.string().trim().max(5000).nullable().default(null),
  defaultRepairType: RepairType.nullable().default(null),
  defaultPriority: TicketPriority.nullable().default(null),
  defaultEstimatedMinutes: z.number().int().min(1).max(720).nullable().default(null),
  lines: z.array(templateLineSchema).max(100, 'Не более 100 строк в шаблоне'),
});

const updateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    defaultRepairType: RepairType.nullable().optional(),
    defaultPriority: TicketPriority.nullable().optional(),
    defaultEstimatedMinutes: z.number().int().min(1).max(720).nullable().optional(),
    lines: z.array(templateLineSchema).max(100).optional(),
  })
  .strict();

export const ticketTemplatesRouter = router({
  list: staffProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(({ ctx, input }) =>
      listTemplatesQuery(buildCmdCtx(ctx), {
        includeArchived: input?.includeArchived ?? false,
      }),
    ),

  get: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getTemplateQuery(buildCmdCtx(ctx), input.id)),

  create: staffProcedure.input(createInputSchema).mutation(({ ctx, input }) =>
    createTemplateCmd(buildCmdCtx(ctx), {
      name: input.name,
      description: input.description,
      defaultRepairType: input.defaultRepairType,
      defaultPriority: input.defaultPriority,
      defaultEstimatedMinutes: input.defaultEstimatedMinutes,
      lines: input.lines,
    }),
  ),

  update: staffProcedure
    .input(z.object({ id: z.string().uuid(), patch: updateInputSchema }))
    .mutation(({ ctx, input }) => updateTemplateCmd(buildCmdCtx(ctx), input.id, input.patch)),

  archive: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => archiveTemplateCmd(buildCmdCtx(ctx), input.id)),

  unarchive: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => unarchiveTemplateCmd(buildCmdCtx(ctx), input.id)),

  applyToTicket: staffProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        templateId: z.string().uuid(),
      }),
    )
    .mutation(({ ctx, input }) => applyTemplateCmd(buildCmdCtx(ctx), input)),
});
