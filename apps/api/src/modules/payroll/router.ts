/**
 * tRPC роутер payroll.
 *
 * Чтение rule + расчёт ЗП — directorProcedure.
 * Расчёт своей ЗП (myEarnings) — engineerProcedure (инженер видит только себя).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { directorProcedure, engineerProcedure, router } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  computePayoutsQuery,
  createPayoutCmd,
  deletePayoutCmd,
  getRuleQuery,
  listPayoutsQuery,
  setEngineersSeeEarningsCmd,
  setRuleCmd,
  updatePayoutCmd,
} from './service';

const periodPresetSchema = z.object({
  preset: z.enum(['today', 'week', 'month', 'quarter', 'custom']),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
});

const payrollModeSchema = z.enum(['piecework', 'salary_bonus']);

const MAX_AMOUNT_RUB = 9_999_999_999;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD');
const rubToKopecks = (rub: number): bigint => BigInt(Math.round(rub * 100));

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

  /**
   * Расчёт своей ЗП (инженер). Если директор отключил показ заработка инженерам,
   * возвращаем { enabled: false } БЕЗ финансовых данных — инженер не сможет
   * обойти запрет через прямой вызов API.
   */
  myEarnings: engineerProcedure
    .input(periodPresetSchema)
    .query(async ({ ctx, input }) => {
      if (ctx.session.role !== 'engineer') {
        // Директор/диспетчер вызывают computePayouts — у них есть видимость по всем
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'myEarnings — только для роли engineer',
        });
      }
      const rule = await getRuleQuery(ctx.db, ctx.tenant.id);
      if (!rule.engineersSeeEarnings) {
        return { enabled: false as const };
      }
      const result = await computePayoutsQuery(ctx.db, ctx.tenant.id, {
        ...input,
        engineerId: ctx.session.userId,
      });
      return { enabled: true as const, ...result };
    }),

  /** Тумблер: показывать инженерам их заработок в кабинете (директор). */
  setEngineersSeeEarnings: directorProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setEngineersSeeEarningsCmd(ctx.db, ctx.tenant.id, input.enabled),
    ),

  /* ── Выплаты ЗП (директор) ── */

  /** Выплаты за период (по period_start) — для отметки «Выплачено» в таблице. */
  listPayouts: directorProcedure
    .input(periodPresetSchema)
    .query(({ ctx, input }) => listPayoutsQuery(ctx.db, ctx.tenant.id, input)),

  /** Провести выплату инженеру: расход в кассе + запись факта. */
  createPayout: directorProcedure
    .input(
      periodPresetSchema.extend({
        engineerId: z.string().uuid(),
        amountRub: z.number().positive().max(MAX_AMOUNT_RUB),
        paidOn: isoDate,
        accountId: z.string().uuid(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      createPayoutCmd(buildCmdCtx(ctx), {
        engineerId: input.engineerId,
        period: { preset: input.preset, start: input.start, end: input.end },
        amountKopecks: rubToKopecks(input.amountRub),
        paidOn: input.paidOn,
        accountId: input.accountId,
        comment: input.comment ?? null,
      }),
    ),

  /** Ручная правка выплаты (сумма/дата/счёт/комментарий). */
  updatePayout: directorProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        amountRub: z.number().positive().max(MAX_AMOUNT_RUB).optional(),
        paidOn: isoDate.optional(),
        accountId: z.string().uuid().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      updatePayoutCmd(buildCmdCtx(ctx), input.id, {
        amountKopecks: input.amountRub !== undefined ? rubToKopecks(input.amountRub) : undefined,
        paidOn: input.paidOn,
        accountId: input.accountId,
        comment: input.comment,
      }),
    ),

  /** Отмена выплаты: убирает расход из кассы. */
  deletePayout: directorProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deletePayoutCmd(buildCmdCtx(ctx), input.id)),
});
