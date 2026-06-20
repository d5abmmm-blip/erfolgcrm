/**
 * tRPC роутер dashboard — аналитика только для директора.
 * Исключение: navBadges (счётчики бейджей навигации) доступен всем ролям —
 * это навигация, а не отчётность; данные ролевые (см. getNavBadgeCounts).
 * Все методы — query (read-only).
 */
import { z } from 'zod';
import { directorProcedure, engineerProcedure, router } from '../../trpc/trpc';
import {
  getDailySummaryQuery,
  getMetricsCmd,
  getNavBadgesQuery,
  listLowStockQuery,
  listMaintenanceForTodayQuery,
  listOverdueInvoicesQuery,
  listSlaAtRiskQuery,
} from './service';

const periodPresetSchema = z.object({
  preset: z.enum(['today', 'week', 'month', 'quarter', 'custom']),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
});

const limitSchema = z.number().int().min(1).max(500).optional();

export const dashboardRouter = router({
  getMetrics: directorProcedure
    .input(periodPresetSchema)
    .query(({ ctx, input }) => getMetricsCmd(ctx.db, ctx.tenant.id, input)),

  listOverdueInvoices: directorProcedure
    .input(z.object({ limit: limitSchema }).optional())
    .query(({ ctx, input }) =>
      listOverdueInvoicesQuery(ctx.db, ctx.tenant.id, input?.limit),
    ),

  listSlaAtRisk: directorProcedure
    .input(z.object({ limit: limitSchema }).optional())
    .query(({ ctx, input }) =>
      listSlaAtRiskQuery(ctx.db, ctx.tenant.id, input?.limit),
    ),

  listLowStock: directorProcedure
    .input(z.object({ limit: limitSchema }).optional())
    .query(({ ctx, input }) =>
      listLowStockQuery(ctx.db, ctx.tenant.id, input?.limit),
    ),

  listMaintenanceToday: directorProcedure
    .input(
      z
        .object({
          includeOverdue: z.boolean().optional(),
          limit: limitSchema,
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listMaintenanceForTodayQuery(
        ctx.db,
        ctx.tenant.id,
        input?.includeOverdue ?? true,
        input?.limit,
      ),
    ),

  getDailySummary: directorProcedure
    .input(z.object({ date: z.string().datetime() }))
    .query(({ ctx, input }) =>
      getDailySummaryQuery(ctx.db, ctx.tenant.id, input.date),
    ),

  /** Счётчики «требует внимания» для бейджей бокового меню (ролевые). */
  navBadges: engineerProcedure.query(({ ctx }) =>
    getNavBadgesQuery(ctx.db, ctx.tenant.id, ctx.session.role, ctx.session.userId),
  ),
});
