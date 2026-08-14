/**
 * tRPC роутер профиля инженера: навыки (типы техники) и занятость.
 *
 * Чтение — staff (нужно доске и назначению). Правку навыков и занятость ставит любой
 * из staff: решение владельца 2026-08-15 — техника не была отмечена у 11 инженеров из
 * 14 именно потому, что отметить её мог только директор, а в программе каждый день
 * сидит менеджер. Без отметки не работает подсказка «кому отдать заявку».
 */
import { z } from 'zod';
import { router, staffProcedure } from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import {
  deleteAvailability,
  listAvailability,
  listActiveAvailability,
  listSkills,
  setAvailability,
  setSkills,
} from './repository';
import { assignmentHints } from './hints';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');
const kindSchema = z.enum(['day_off', 'vacation', 'onsite']);

/** Дата «сегодня» в таймзоне организации (YYYY-MM-DD). */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export const engineerProfileRouter = router({
  listSkills: staffProcedure.query(({ ctx }) => listSkills(ctx.db, ctx.tenant.id)),

  setSkills: staffProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        deviceTypes: z.array(z.string().trim().max(100)).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await setSkills(ctx.db, ctx.tenant.id, input.userId, input.deviceTypes);
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'user',
        entityId: input.userId,
        after: { skills: result },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { deviceTypes: result };
    }),

  listAvailability: staffProcedure
    .input(z.object({ userId: z.string().uuid().optional() }).optional())
    .query(({ ctx, input }) => listAvailability(ctx.db, ctx.tenant.id, input?.userId)),

  /** Занятость, актуальная сегодня (для бейджей на доске). */
  availabilityToday: staffProcedure.query(({ ctx }) =>
    listActiveAvailability(ctx.db, ctx.tenant.id, todayInTz(ctx.tenant.timezone)),
  ),

  /**
   * Умные подсказки при назначении инженера (только чтение): загрузка, навык под
   * тип техники, занятость сегодня, предупреждение об аттестации. Доступно staff.
   */
  assignmentHints: staffProcedure
    .input(
      z
        .object({
          deviceType: z.string().trim().max(100).nullable().optional(),
          assetId: z.string().uuid().nullable().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      assignmentHints(ctx.db, ctx.tenant.id, ctx.tenant.timezone, {
        deviceType: input?.deviceType ?? null,
        assetId: input?.assetId ?? null,
      }),
    ),

  setAvailability: staffProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        kind: kindSchema,
        dateFrom: dateSchema,
        dateTo: dateSchema,
        note: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.dateTo < input.dateFrom) {
        throw new Error('Дата окончания раньше даты начала');
      }
      const result = await setAvailability(ctx.db, ctx.tenant.id, {
        userId: input.userId,
        kind: input.kind,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        note: input.note ?? null,
      });
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'create',
        entityType: 'user',
        entityId: input.userId,
        after: { availability: input.kind, from: input.dateFrom, to: input.dateTo },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return result;
    }),

  deleteAvailability: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await deleteAvailability(ctx.db, ctx.tenant.id, input.id);
      return { ok: true };
    }),
});
