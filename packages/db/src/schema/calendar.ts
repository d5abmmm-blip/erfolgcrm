/**
 * Пользовательские события календаря — заметки менеджеров с датой:
 * встречи, поставки, напоминания. Не привязаны к заявкам/договорам,
 * показываются в разделе «Календарь» вместе с системными событиями.
 */
import { date, index, pgTable, text, time, uuid, varchar } from 'drizzle-orm/pg-core';
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

    /** Кто создал (для аудита). Без FK — пользователи не удаляются физически. */
    createdByUserId: uuid('created_by_user_id'),

    ...timestamps,
  },
  (t) => [
    index('calendar_events_tenant_date_idx')
      .on(t.tenantId, t.eventDate)
      .where(sql`deleted_at IS NULL`),
  ],
);
