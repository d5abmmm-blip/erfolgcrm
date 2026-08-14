/**
 * tRPC роутер журнала посещений (табеля).
 *
 * RBAC: весь раздел — staffProcedure (директор + диспетчер). Инженеру журнал не
 * показываем и заполнять не даём: решение владельца — отметки ведёт менеджер в
 * десктопной CRM, контакт инженеров с программой минимизируем.
 */
import { z } from 'zod';
import { router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import { monthQuery, removeCmd, upsertCmd } from './service';

/** YYYY-MM-DD — та же форма, что и колонка date в БД. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата должна быть в формате ГГГГ-ММ-ДД');

/** HH:MM в сутках. Секунды в табеле не ведут. */
const hhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время должно быть в формате ЧЧ:ММ');

const statusEnum = z.enum([
  'present',
  'day_off',
  'sick',
  'vacation',
  'business_trip',
  'absent',
  'unpaid_leave',
]);

export const attendanceRouter = router({
  month: staffProcedure
    .input(
      z.object({
        year: z.number().int().min(2000).max(2100),
        month: z.number().int().min(1).max(12),
      }),
    )
    .query(({ ctx, input }) => monthQuery(ctx.db, ctx.tenant, input)),

  upsert: staffProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        workDate: isoDate,
        status: statusEnum,
        arrivedAt: hhMm.nullable().optional(),
        leftAt: hhMm.nullable().optional(),
        note: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => upsertCmd(buildCmdCtx(ctx), input)),

  remove: staffProcedure
    .input(z.object({ userId: z.string().uuid(), workDate: isoDate }))
    .mutation(({ ctx, input }) => removeCmd(buildCmdCtx(ctx), input)),
});
