/**
 * Пользовательские события календаря — заметки менеджеров с датой:
 * встречи, поставки, напоминания. Не привязаны к заявкам/договорам,
 * показываются в разделе «Календарь» вместе с системными событиями.
 */
import { date, index, pgTable, text, time, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pk, tenantId, timestamps } from './_shared';

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: pk(),
    tenantId: tenantId(),

    title: varchar('title', { length: 200 }).notNull(),

    /** День события (в календаре дни считаются по поясу организации). */
    eventDate: date('event_date').notNull(),
    /** Время HH:MM. NULL — событие «на весь день». */
    eventTime: time('event_time'),

    notes: text('notes'),

    /**
     * Когда отправить push-напоминание (накануне в 09:00 пояса организации).
     * NULL — не запрошено или момент уже в прошлом на момент создания/правки.
     */
    remindAt: timestamp('remind_at', { withTimezone: true }),
    /** Когда напоминание фактически отправлено (повторно не шлём). */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),

    /** Кто создал (для аудита и адресат напоминания). Без FK. */
    createdByUserId: uuid('created_by_user_id'),

    ...timestamps,
  },
  (t) => [
    index('calendar_events_tenant_date_idx')
      .on(t.tenantId, t.eventDate)
      .where(sql`deleted_at IS NULL`),
  ],
);
