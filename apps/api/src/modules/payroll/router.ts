/**
 * tRPC роутер payroll.
 *
 * Чтение rule + расчёт ЗП — directorProcedure.
 * Расчёт своей ЗП (myEarnings) — engineerProcedure (инженер видит только себя).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { directorProcedure, engineerProcedure, router } from '../../trpc/trpc';
import {
  computePayoutsQuery,
  getRuleQuery,
  setRuleCmd,
} from './service';

const periodPresetSchema = z.object({
  preset: z.enum(['today', 'week', 'month', 'quarter', 'custom']),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
});

const payrollModeSchema = z.enum(['piecework', 'salary_bonus']);

export const payrollRouter = router({
  getRule: directorProcedure.query(({ ctx }) =>
    getRuleQuery(ctx.db, ctx.tenant.id),
  ),

  setRule: directorProcedure
    .input(
      z.object({
        mode: payrollModeSchema,
        pieceworkPercent: z.number().int().min(0).max(100).optional(),
        baseSalaryKopecks: z.string().regex(/^\d+$/).optional(),
        bonusPercent: z.number().int().min(0).max(100).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setRuleCmd(ctx.db, ctx.tenant.id, {
        mode: input.mode,
        pieceworkPercent: input.pieceworkPercent,
        baseSalaryKopecks: input.baseSalaryKopecks
          ? BigInt(input.baseSalaryKopecks)
          : undefined,
        bonusPercent: input.bonusPercent,
      }),
    ),

  /** Расчёт ЗП по всем инженерам (директор). */
  computePayouts: directorProcedure
    .input(
      periodPresetSchema.extend({
        engineerId: z.string().uuid().optional(),
      }),
    )
    .query(({ ctx, input }) =>
      computePayoutsQuery(ctx.db, ctx.tenant.id, input),
    ),

  /** Расчёт своей ЗП (инженер). */
  myEarnings: engineerProcedure
    .input(periodPresetSchema)
    .query(({ ctx, input }) => {
      if (ctx.session.role !== 'engineer') {
        // Директор/диспетчер вызывают computePayouts — у них есть видимость по всем
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'myEarnings — только для роли engineer',
        });
      }
      return computePayoutsQuery(ctx.db, ctx.tenant.id, {
        ...input,
        engineerId: ctx.session.userId,
      });
    }),
});
