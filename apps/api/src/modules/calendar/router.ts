/**
 * tRPC роутер календаря компании.
 *
 * RBAC: staffProcedure (директор + диспетчер) — как у «Графика»: инженеры
 * видят свои выезды в PWA и недельном графике, общий календарь — операционный
 * инструмент менеджеров.
 *
 * Свои события (createEvent/updateEvent/deleteEvent) — заметки менеджеров;
 * каждая мутация пишется в AuditLog.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, staffProcedure } from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listMonthEvents,
  updateCalendarEvent,
} from './repository';

const eventFields = {
  title: z.string().trim().min(1, 'Укажите название').max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД'),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ')
    .nullish(),
  notes: z.string().trim().max(2000).nullish(),
  /** Push-напоминание накануне в 09:00 (пояс организации). */
  remind: z.boolean().optional().default(false),
};

export const calendarRouter = router({
  month: staffProcedure
    .input(
      z.object({
        year: z.number().int().min(2020).max(2100),
        month: z.number().int().min(1).max(12),
      }),
    )
    .query(({ ctx, input }) =>
      listMonthEvents(ctx.db, ctx.tenant.id, ctx.tenant.timezone, input.year, input.month),
    ),

  createEvent: staffProcedure.input(z.object(eventFields)).mutation(async ({ ctx, input }) => {
    const created = await createCalendarEvent(
      ctx.db,
      ctx.tenant.id,
      ctx.session.userId,
      ctx.tenant.timezone,
      {
        title: input.title,
        date: input.date,
        time: input.time ?? null,
        notes: input.notes?.trim() ? input.notes.trim() : null,
        remind: input.remind,
      },
    );
    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'create',
      entityType: 'calendar_event',
      entityId: created.id,
      after: { title: input.title, date: input.date, time: input.time ?? null },
      ip: ctx.ip,
    });
    return created;
  }),

  updateEvent: staffProcedure
    .input(z.object({ id: z.string().uuid(), ...eventFields }))
    .mutation(async ({ ctx, input }) => {
      const ok = await updateCalendarEvent(ctx.db, ctx.tenant.id, input.id, ctx.tenant.timezone, {
        title: input.title,
        date: input.date,
        time: input.time ?? null,
        notes: input.notes?.trim() ? input.notes.trim() : null,
        remind: input.remind,
      });
      if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Событие не найдено' });
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'calendar_event',
        entityId: input.id,
        after: { title: input.title, date: input.date, time: input.time ?? null },
        ip: ctx.ip,
      });
      return { ok: true };
    }),

  deleteEvent: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await deleteCalendarEvent(ctx.db, ctx.tenant.id, input.id);
      if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Событие не найдено' });
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'delete',
        entityType: 'calendar_event',
        entityId: input.id,
        ip: ctx.ip,
      });
      return { ok: true };
    }),
});
