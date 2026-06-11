/**
 * tRPC роутер для maintenance.
 * RBAC: списки и recordPerformed — engineer; правки графиков — staffProcedure.
 */
import { z } from 'zod';
import { engineerProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  createScheduleCmd,
  listLogQuery,
  listSchedulesQuery,
  recordPerformedCmd,
  updateScheduleCmd,
} from './service';

export const maintenanceRouter = router({
  listSchedules: engineerProcedure
    .input(
      z.object({
        filter: z.enum(['overdue', 'due_soon', 'all_active', 'inactive']).optional(),
        assetId: z.string().uuid().optional(),
      }),
    )
    .query(({ ctx, input }) => listSchedulesQuery(ctx.db, ctx.tenant, input)),

  listLog: engineerProcedure
    .input(
      z.object({
        assetId: z.string().uuid().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ ctx, input }) => listLogQuery(ctx.db, ctx.tenant, input)),

  createSchedule: staffProcedure
    .input(
      z.object({
        assetId: z.string().uuid(),
        kind: z.enum(['planned', 'urgent']),
        intervalDays: z.number().int().min(1).max(3650),
        responsibleUserId: z.string().uuid().nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
        startAt: z.coerce.date().optional(),
      }),
    )
    .mutation(({ ctx, input }) => createScheduleCmd(buildCmdCtx(ctx), input)),

  updateSchedule: staffProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            kind: z.enum(['planned', 'urgent']).optional(),
            intervalDays: z.number().int().min(1).max(3650).optional(),
            responsibleUserId: z.string().uuid().nullable().optional(),
            notes: z.string().trim().max(2000).nullable().optional(),
            isActive: z.boolean().optional(),
          })
          .strict(),
      }),
    )
    .mutation(({ ctx, input }) =>
      updateScheduleCmd(buildCmdCtx(ctx), input.id, input.patch),
    ),

  recordPerformed: engineerProcedure
    .input(
      z.object({
        assetId: z.string().uuid(),
        scheduleId: z.string().uuid().nullable().optional(),
        ticketId: z.string().uuid().nullable().optional(),
        performedAt: z.coerce.date().optional(),
        summary: z.string().trim().min(1).max(1000),
        notes: z.string().trim().max(5000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      recordPerformedCmd(buildCmdCtx(ctx), {
        assetId: input.assetId,
        scheduleId: input.scheduleId ?? null,
        ticketId: input.ticketId ?? null,
        performedAt: input.performedAt ?? new Date(),
        summary: input.summary,
        notes: input.notes ?? null,
      }),
    ),
});
