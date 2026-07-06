/**
 * tRPC роутер reports — периодные аналитические отчёты (read-only).
 * RBAC: staffProcedure (директор + диспетчер); дебиторка — только директор
 * (паритет с v1: receivables был directorProcedure).
 */
import { z } from 'zod';
import { directorProcedure, router, staffProcedure } from '../../trpc/trpc';
import {
  engineerPerformance,
  leadsFunnel,
  profitabilityReport,
  receivables,
  revenueByClient,
  slaCompliance,
} from './repository';
import { buildMonthlySummary } from './monthly-summary';

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Дата должна быть в формате YYYY-MM-DD' });

const monthString = z
  .string()
  .regex(/^\d{4}-\d{2}$/, { message: 'Месяц должен быть в формате YYYY-MM' });

const periodSchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

export const reportsRouter = router({
  revenueByClient: staffProcedure
    .input(periodSchema)
    .query(({ ctx, input }) => revenueByClient(ctx.db, ctx.tenant.id, input)),

  engineerPerformance: staffProcedure
    .input(periodSchema)
    .query(({ ctx, input }) => engineerPerformance(ctx.db, ctx.tenant.id, input)),

  /** Рентабельность (выручка/маржа) по инженеру и типу техники. Маржа — только директору. */
  profitability: directorProcedure
    .input(periodSchema)
    .query(({ ctx, input }) => profitabilityReport(ctx.db, ctx.tenant.id, input)),

  slaCompliance: staffProcedure
    .input(periodSchema)
    .query(({ ctx, input }) => slaCompliance(ctx.db, ctx.tenant.id, input)),

  leadsFunnel: staffProcedure
    .input(periodSchema)
    .query(({ ctx, input }) => leadsFunnel(ctx.db, ctx.tenant.id, input)),

  receivables: directorProcedure.query(({ ctx }) => receivables(ctx.db, ctx.tenant.id)),

  /**
   * AI-итог месяца директору: касса + рентабельность + дебиторка за месяц одним текстом.
   * Финансы+маржа → только директор. Деградирует до фактов без LLM (text=null).
   */
  monthlySummary: directorProcedure
    .input(z.object({ month: monthString.optional() }))
    .query(({ ctx, input }) => buildMonthlySummary(ctx.db, ctx.tenant, input.month)),
});
