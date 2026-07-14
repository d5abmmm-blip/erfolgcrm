/**
 * tRPC роутер для tickets и ticket_events.
 *
 * RBAC:
 * - list / create / update / addNote / recordPrint — staffProcedure (директор + диспетчер).
 * - get / search / listEvents / changeStatus — engineerProcedure (включая инженера).
 *   Инженер может менять status только в рабочие статусы (diagnostics/in_progress/act_pending).
 * - cancel / reopen — directorProcedure.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  IntakeMethod,
  RepairType,
  TicketBlockedReason,
  TicketPriority,
  TicketSource,
  TicketStatus,
} from '@erfolg/shared';
import {
  router,
  directorProcedure,
  engineerProcedure,
  staffProcedure,
} from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  addTicketNoteCmd,
  boardQuery,
  cancelTicketCmd,
  deleteTicketCmd,
  changeStatusCmd,
  createTicketCmd,
  engineerReactCmd,
  getTicketQuery,
  getTrackShareCmd,
  revokeTrackShareCmd,
  listEventsQuery,
  listTicketsQuery,
  myTicketsQuery,
  myWeeklyScheduleQuery,
  partsWaitingQuery,
  documentClientQuery,
  recordPrintEventCmd,
  reopenTicketCmd,
  scheduleCmd,
  setBlockedReasonCmd,
  setWaitingForPartCmd,
  searchTicketsQuery,
  unscheduleCmd,
  updateTicketCmd,
  weeklyScheduleQuery,
} from './service';

const ENGINEER_ALLOWED_STATUSES: ReadonlyArray<z.infer<typeof TicketStatus>> = [
  'diagnostics',
  'in_progress',
  'act_pending',
];

const createTicketSchema = z.object({
  clientId: z.string().uuid(),
  assetId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  contractId: z.string().uuid().nullable().optional(),
  source: TicketSource.optional(),
  intakeMethod: IntakeMethod.optional(),
  repairType: RepairType.optional(),
  priority: TicketPriority.optional(),
  symptom: z.string().trim().max(5000).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  assignedDispatcherId: z.string().uuid().nullable().optional(),
  assignedEngineerId: z.string().uuid().nullable().optional(),
  slaTargetAt: z.coerce.date().nullable().optional(),
  deadlineAt: z.coerce.date().nullable().optional(),
});

const updateTicketSchema = z
  .object({
    clientId: z.string().uuid().optional(),
    assetId: z.string().uuid().nullable().optional(),
    contactId: z.string().uuid().nullable().optional(),
    contractId: z.string().uuid().nullable().optional(),
    source: TicketSource.optional(),
    intakeMethod: IntakeMethod.optional(),
    repairType: RepairType.optional(),
    priority: TicketPriority.optional(),
    symptom: z.string().trim().max(5000).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    assignedDispatcherId: z.string().uuid().nullable().optional(),
    assignedEngineerId: z.string().uuid().nullable().optional(),
    slaTargetAt: z.coerce.date().nullable().optional(),
    deadlineAt: z.coerce.date().nullable().optional(),
  })
  .strict();

const changeStatusSchema = z.object({
  id: z.string().uuid(),
  status: TicketStatus,
  cancelReason: z.string().trim().max(2000).optional(),
});

/**
 * Stage 11 — расписание инженеров.
 * estimatedMinutes от 15 минут (минимум осмысленного интервала) до 720 (12 часов).
 */
const scheduleInputSchema = z.object({
  ticketId: z.string().uuid(),
  engineerId: z.string().uuid(),
  scheduledStartAt: z.coerce.date(),
  scheduledEndAt: z.coerce.date().optional(),
  estimatedMinutes: z.number().int().min(15).max(720).optional(),
});

const weeklyScheduleInputSchema = z.object({
  weekStart: z.coerce.date(),
});

export const ticketsRouter = router({
  list: staffProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(100).optional(),
          statuses: z.array(TicketStatus).optional(),
          /** Фильтр по срочности (UI «только срочные» шлёт ['urgent']). */
          priorities: z.array(TicketPriority).optional(),
          engineerId: z.string().uuid().optional(),
          /** Только заявки без назначенного инженера (канбан, фильтр «без назначения»). */
          unassigned: z.boolean().optional(),
          clientId: z.string().uuid().optional(),
          contractId: z.string().uuid().optional(),
          /** Stage 11 — фильтр по наличию расписания (для UI «незапланированные»). */
          scheduled: z.boolean().optional(),
          /** Фича A — только заявки, ждущие запчасть. */
          waitingForPart: z.boolean().optional(),
          /** Порядок: 'priority' — срочные наверх (рабочие очереди). Дефолт 'received'. */
          sort: z.enum(['received', 'priority']).optional(),
          page: z.number().int().positive().max(1000).optional(),
          pageSize: z.number().int().positive().max(200).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listTicketsQuery(ctx.db, ctx.tenant, input ?? {})),

  /**
   * «Мои заявки» для PWA инженера: тот же список, но engineerId жёстко = я.
   * list остаётся staff-only (там фильтры по любому инженеру/клиенту).
   */
  myList: engineerProcedure
    .input(
      z
        .object({
          statuses: z.array(TicketStatus).optional(),
          page: z.number().int().positive().max(1000).optional(),
          pageSize: z.number().int().positive().max(200).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listTicketsQuery(ctx.db, ctx.tenant, {
        ...(input ?? {}),
        engineerId: ctx.session.userId,
      }),
    ),

  /** «Мой день»: мои активные заявки с полями доски (stuckDays / светофор / причина). */
  myTickets: engineerProcedure.query(({ ctx }) =>
    myTicketsQuery(ctx.db, ctx.tenant, ctx.session.userId),
  ),

  /** Реакция одной кнопкой (Мой день / web-push / Telegram-паритет). */
  engineerReact: engineerProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        action: z.enum(['inwork', 'ready', 'part']),
      }),
    )
    .mutation(({ ctx, input }) =>
      engineerReactCmd(buildCmdCtx(ctx), input.ticketId, input.action),
    ),

  get: engineerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getTicketQuery(ctx.db, ctx.tenant, input.id)),

  search: engineerProcedure
    .input(z.object({ q: z.string().trim().min(1).max(100) }))
    .query(({ ctx, input }) => searchTicketsQuery(ctx.db, ctx.tenant, input.q)),

  events: engineerProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        limit: z.number().int().positive().max(500).optional(),
      }),
    )
    .query(({ ctx, input }) => listEventsQuery(ctx.db, ctx.tenant, input.ticketId, input.limit)),

  create: staffProcedure
    .input(createTicketSchema)
    .mutation(({ ctx, input }) => createTicketCmd(buildCmdCtx(ctx), input)),

  update: staffProcedure
    .input(z.object({ id: z.string().uuid(), patch: updateTicketSchema }))
    .mutation(({ ctx, input }) =>
      updateTicketCmd(buildCmdCtx(ctx), input.id, input.patch),
    ),

  addNote: engineerProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        comment: z.string().trim().min(1).max(5000),
      }),
    )
    .mutation(({ ctx, input }) =>
      addTicketNoteCmd(buildCmdCtx(ctx), input.ticketId, input.comment),
    ),

  /** Фича A — установить/снять флаг «Ждём запчасть» + заметку. */
  setWaitingForPart: staffProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        waiting: z.boolean(),
        note: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setWaitingForPartCmd(buildCmdCtx(ctx), input.ticketId, input.waiting, input.note ?? null),
    ),

  /** Фича №3 — выдать/создать публичную ссылку отслеживания для клиента (staff). */
  getShareLink: staffProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .mutation(({ ctx, input }) => getTrackShareCmd(buildCmdCtx(ctx), input.ticketId)),

  /** Фича №3 — отозвать публичную ссылку отслеживания (staff). */
  revokeShareLink: staffProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .mutation(({ ctx, input }) => revokeTrackShareCmd(buildCmdCtx(ctx), input.ticketId)),

  /** Доска — все активные заявки с причиной простоя и светофором (staff). */
  board: staffProcedure.query(({ ctx }) => boardQuery(ctx.db, ctx.tenant)),

  /** Фича №7 — заявки, стоящие из-за ожидания детали (staff). Дольше всех — сверху. */
  partsWaiting: staffProcedure.query(({ ctx }) => partsWaitingQuery(ctx.db, ctx.tenant)),

  /** Доска — установить/снять структурную причину простоя (reason=null снимает). */
  setBlockedReason: staffProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        reason: TicketBlockedReason.nullable(),
        note: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setBlockedReasonCmd(buildCmdCtx(ctx), input.ticketId, input.reason, input.note ?? null),
    ),

  /** Фиксация печати документа. Инженер — только по своим заявкам (проверка в cmd). */
  recordPrint: engineerProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        documentKind: z.enum(['intake_act', 'invoice', 'work_act', 'defect_act', 'tech_condition_act']),
      }),
    )
    .mutation(({ ctx, input }) =>
      recordPrintEventCmd(buildCmdCtx(ctx), input.ticketId, input.documentKind),
    ),

  /**
   * Реквизиты клиента для печати акта по заявке (минимум полей: ИНН/КПП/ОГРН/
   * юр.адрес/телефон/контакт). Позволяет инженеру самому сформировать полноценный
   * акт, не открывая ему карточку клиента. Инженер — только по своим заявкам.
   */
  documentClient: engineerProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      documentClientQuery(ctx.db, ctx.tenant, ctx.session, input.ticketId),
    ),

  changeStatus: engineerProcedure.input(changeStatusSchema).mutation(({ ctx, input }) => {
    if (
      ctx.session.role === 'engineer' &&
      !ENGINEER_ALLOWED_STATUSES.includes(input.status)
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Инженер может ставить только diagnostics / in_progress / act_pending',
      });
    }
    return changeStatusCmd(
      buildCmdCtx(ctx),
      input.id,
      input.status,
      input.cancelReason ?? null,
    );
  }),

  cancel: directorProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        reason: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      cancelTicketCmd(buildCmdCtx(ctx), input.id, input.reason ?? null),
    ),

  reopen: directorProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => reopenTicketCmd(buildCmdCtx(ctx), input.id)),

  /**
   * Удаление заявки — только директор. Мягкое (deleted_at): заявка исчезает из всех
   * списков и отчётов, данные остаются (обратимо). Заявки с оплатами/выставленными
   * счетами вернут BAD_REQUEST — их нужно отменять, а не удалять.
   */
  delete: directorProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        reason: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      deleteTicketCmd(buildCmdCtx(ctx), input.id, input.reason ?? null),
    ),

  /* ──────────────────── Stage 11: Schedule ──────────────────── */

  schedule: staffProcedure
    .input(scheduleInputSchema)
    .mutation(({ ctx, input }) =>
      scheduleCmd(buildCmdCtx(ctx), {
        ticketId: input.ticketId,
        engineerId: input.engineerId,
        scheduledStartAt: input.scheduledStartAt,
        scheduledEndAt: input.scheduledEndAt ?? null,
        estimatedMinutes: input.estimatedMinutes ?? null,
      }),
    ),

  unschedule: staffProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      unscheduleCmd(buildCmdCtx(ctx), { ticketId: input.ticketId }),
    ),

  weeklySchedule: staffProcedure
    .input(weeklyScheduleInputSchema)
    .query(({ ctx, input }) =>
      weeklyScheduleQuery(buildCmdCtx(ctx), { weekStart: input.weekStart }),
    ),

  myWeeklySchedule: engineerProcedure
    .input(weeklyScheduleInputSchema)
    .query(({ ctx, input }) =>
      myWeeklyScheduleQuery(buildCmdCtx(ctx), { weekStart: input.weekStart }),
    ),
});
