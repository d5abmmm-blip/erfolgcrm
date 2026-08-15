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
import {
  deleteSheet,
  getSheetByMonth,
  listSheets,
  postToCash,
  saveSheet,
  unpostFromCash,
} from './sheets';
import { getStaffMoney } from './staff-money';

const periodPresetSchema = z.object({
  preset: z.enum(['today', 'week', 'month', 'quarter', 'custom']),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
});

const payrollModeSchema = z.enum(['piecework', 'salary_bonus']);

const MAX_AMOUNT_RUB = 9_999_999_999;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD');
const monthKey = z.string().regex(/^\d{4}-\d{2}$/, 'Месяц в формате YYYY-MM');
const rubToKopecks = (rub: number): bigint => BigInt(Math.round(rub * 100));
const rubToKopecksInt = (rub: number): number => Math.round(rub * 100);

export const payrollRouter = router({
  getRule: directorProcedure.query(({ ctx }) => getRuleQuery(ctx.db, ctx.tenant.id)),

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
        baseSalaryKopecks: input.baseSalaryKopecks ? BigInt(input.baseSalaryKopecks) : undefined,
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
    .query(({ ctx, input }) => computePayoutsQuery(ctx.db, ctx.tenant.id, input)),

  /**
   * Расчёт своей ЗП (инженер). Если директор отключил показ заработка инженерам,
   * возвращаем { enabled: false } БЕЗ финансовых данных — инженер не сможет
   * обойти запрет через прямой вызов API.
   */
  myEarnings: engineerProcedure.input(periodPresetSchema).query(async ({ ctx, input }) => {
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

  /**
   * Вкладка «Деньги» на карточке сотрудника: условия оплаты, начислено за месяц,
   * строки ведомостей и история выплат одного человека. Только директор — как и
   * весь расчёт ЗП; карточку целиком видит и менеджер, но эту вкладку сервер
   * ему не отдаёт.
   */
  staffMoney: directorProcedure
    .input(z.object({ userId: z.string().uuid(), month: monthKey }))
    .query(async ({ ctx, input }) => {
      const dto = await getStaffMoney(ctx.db, ctx.tenant.id, input.userId, input.month);
      if (!dto) throw new TRPCError({ code: 'NOT_FOUND', message: 'Сотрудник не найден' });
      return dto;
    }),

  /** Тумблер: показывать инженерам их заработок в кабинете (директор). */
  setEngineersSeeEarnings: directorProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEngineersSeeEarningsCmd(ctx.db, ctx.tenant.id, input.enabled)),

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
        kind: z.enum(['advance', 'final', 'bonus']).default('final'),
        amountRub: z.number().positive().max(MAX_AMOUNT_RUB),
        paidOn: isoDate,
        accountId: z.string().uuid(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      createPayoutCmd(buildCmdCtx(ctx), {
        engineerId: input.engineerId,
        kind: input.kind,
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

  /* ── Ручная ведомость (директор): отдельный журнал, кассу НЕ трогает ── */
  sheets: router({
    /** Все сохранённые ведомости (для годовой сводки). */
    list: directorProcedure.query(({ ctx }) => listSheets(ctx.db, ctx.tenant.id)),

    /** Ведомость за конкретный месяц. */
    getByMonth: directorProcedure
      .input(z.object({ month: monthKey }))
      .query(({ ctx, input }) => getSheetByMonth(ctx.db, ctx.tenant.id, input.month)),

    /** Сохранить/перезаписать ведомость за месяц (перезапись — с причиной ≥10 симв.). */
    save: directorProcedure
      .input(
        z.object({
          month: monthKey,
          entries: z
            .array(
              z.object({
                employeeId: z.string().trim().min(1).max(100),
                employeeName: z.string().trim().max(200),
                salaryRub: z.number().min(0).max(MAX_AMOUNT_RUB),
                pieceworkRub: z.number().min(0).max(MAX_AMOUNT_RUB).default(0),
                advanceRub: z.number().min(0).max(MAX_AMOUNT_RUB),
                bonusRub: z.number().min(0).max(MAX_AMOUNT_RUB),
              }),
            )
            .max(500),
          reason: z.string().trim().min(10).max(500).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        saveSheet(buildCmdCtx(ctx), {
          month: input.month,
          entries: input.entries.map((e) => ({
            employeeId: e.employeeId,
            employeeName: e.employeeName,
            salaryKopecks: rubToKopecksInt(e.salaryRub),
            pieceworkKopecks: rubToKopecksInt(e.pieceworkRub),
            advanceKopecks: rubToKopecksInt(e.advanceRub),
            bonusKopecks: rubToKopecksInt(e.bonusRub),
          })),
          reason: input.reason,
        }),
      ),

    /** Мягко удалить ведомость за месяц. */
    delete: directorProcedure
      .input(z.object({ month: monthKey }))
      .mutation(({ ctx, input }) => deleteSheet(buildCmdCtx(ctx), input.month)),

    /** Провести ведомость в кассу: сумма за месяц → расход (статья «Зарплата»). */
    postToCash: directorProcedure
      .input(z.object({ month: monthKey, accountId: z.string().uuid() }))
      .mutation(({ ctx, input }) => postToCash(buildCmdCtx(ctx), input.month, input.accountId)),

    /** Отменить проведение в кассу. */
    unpost: directorProcedure
      .input(z.object({ month: monthKey }))
      .mutation(({ ctx, input }) => unpostFromCash(buildCmdCtx(ctx), input.month)),
  }),
});
