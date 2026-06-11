/**
 * tRPC роутер metrology.
 *
 * RBAC:
 *   - listSi / getSi / getCalibrations / getDashboard — staffProcedure (директор + диспетчер).
 *   - upsertSiDetails / removeSiDetails / addCalibration — staffProcedure + AuditLog.
 *   - runRemindersNow — directorProcedure (ручной триггер cron-уведомлений; см. worker).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { directorProcedure, router, staffProcedure } from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import {
  addCalibration,
  getDashboardStats,
  getSi,
  listCalibrations,
  listSi,
  removeSiDetails,
  upsertSiDetails,
} from './repository';

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD');

const siInputSchema = z.object({
  typeName: z.string().trim().min(1, 'Укажите тип СИ').max(200),
  patternRegistryNumber: z.string().trim().max(50).nullable().optional(),
  accuracyClass: z.string().trim().max(50).nullable().optional(),
  measurementRange: z.string().trim().max(200).nullable().optional(),
  calibrationIntervalMonths: z.number().int().min(1).max(240),
});

const calibrationInputSchema = z
  .object({
    performedAt: isoDateSchema,
    validUntil: isoDateSchema,
    certificateNumber: z.string().trim().max(100).nullable().optional(),
    calibratorOrg: z.string().trim().max(300).nullable().optional(),
    result: z.enum(['passed', 'failed']),
    notes: z.string().trim().max(5000).nullable().optional(),
    documentAttachmentId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.validUntil >= v.performedAt, {
    message: 'validUntil не может быть раньше performedAt',
    path: ['validUntil'],
  });

export const metrologyRouter = router({
  listSi: staffProcedure
    .input(
      z
        .object({
          clientId: z.string().uuid().optional(),
          status: z.enum(['overdue', 'soon', 'ok', 'all']).optional(),
          search: z.string().trim().max(200).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listSi(ctx.db, ctx.tenant.id, {
        clientId: input?.clientId,
        status: input?.status,
        search: input?.search,
      }),
    ),

  getSi: staffProcedure
    .input(z.object({ assetId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await getSi(ctx.db, ctx.tenant.id, input.assetId);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'СИ не найдено' });
      return row;
    }),

  getCalibrations: staffProcedure
    .input(z.object({ assetId: z.string().uuid() }))
    .query(({ ctx, input }) => listCalibrations(ctx.db, ctx.tenant.id, input.assetId)),

  getDashboard: staffProcedure.query(({ ctx }) =>
    getDashboardStats(ctx.db, ctx.tenant.id),
  ),

  upsertSiDetails: staffProcedure
    .input(z.object({ assetId: z.string().uuid(), input: siInputSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        const row = await upsertSiDetails(
          ctx.db,
          ctx.tenant.id,
          input.assetId,
          input.input,
        );
        await writeAudit(ctx.db, ctx.tenant.id, {
          userId: ctx.session.userId,
          action: 'update',
          entityType: 'metrology_si',
          entityId: input.assetId,
          after: {
            typeName: row.typeName,
            calibrationIntervalMonths: row.calibrationIntervalMonths,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      } catch (err) {
        if (err instanceof Error && err.message.includes('Asset not found')) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Техника не найдена в этом тенанте',
          });
        }
        throw err;
      }
    }),

  removeSiDetails: staffProcedure
    .input(z.object({ assetId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await removeSiDetails(ctx.db, ctx.tenant.id, input.assetId);
      if (!ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'СИ не найдено' });
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'delete',
        entityType: 'metrology_si',
        entityId: input.assetId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { ok: true };
    }),

  addCalibration: staffProcedure
    .input(
      z.object({ assetId: z.string().uuid(), input: calibrationInputSchema }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const row = await addCalibration(
          ctx.db,
          ctx.tenant.id,
          input.assetId,
          input.input,
        );
        await writeAudit(ctx.db, ctx.tenant.id, {
          userId: ctx.session.userId,
          action: 'create',
          entityType: 'metrology_calibration',
          entityId: row.id,
          after: {
            assetId: input.assetId,
            performedAt: row.performedAt,
            validUntil: row.validUntil,
            result: row.result,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      } catch (err) {
        if (err instanceof Error && err.message.includes('SI details not found')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Сначала заведите метрологические атрибуты для этой техники',
          });
        }
        throw err;
      }
    }),

  /**
   * Ручной триггер cron-напоминаний.
   * Реальный cron — через worker. Этот endpoint — для ручного запуска и отладки.
   */
  runRemindersNow: directorProcedure.mutation(async ({ ctx }) => {
    const { processMetrologyReminderTickForTenant } = await import(
      '../../workers/metrology-reminder'
    );
    const stats = await processMetrologyReminderTickForTenant(ctx.tenant.id);
    return stats;
  }),
});
