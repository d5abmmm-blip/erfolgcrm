/**
 * Задачи менеджеров (таск-лист) — дела фирмы с необязательной датой и исполнителем.
 *
 * Отличие от `calendar_events`: у задачи есть состояние «сделано» (is_done),
 * необязательная дата (задача может быть просто «сделать когда-нибудь») и
 * исполнитель (assignee_user_id) — сотрудник или инженер. Инженер видит
 * назначенные ему задачи в мобильном приложении и отмечает их выполненными.
 *
 * Задачи с датой показываются в разделе «Календарь» вместе с событиями.
 */
import {
  boolean,
  date,
  index,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pk, tenantId, timestamps } from './_shared';

export const tasks = pgTable(
  'tasks',
  {
    id: pk(),
    tenantId: tenantId(),

    title: varchar('title', { length: 300 }).notNull(),
    notes: text('notes'),

    /** День задачи (необязателен — задача может быть без даты). */
    dueDate: date('due_date'),
    /** Время HH:MM. NULL — «на весь день»/без времени. */
    dueTime: time('due_time'),

    /** Исполнитель — сотрудник или инженер. NULL — без исполнителя. Без FK (как createdBy). */
    assigneeUserId: uuid('assignee_user_id'),
    /** Кто создал задачу (для аудита и адресат напоминания при отсутствии исполнителя). */
    createdByUserId: uuid('created_by_user_id'),

    isDone: boolean('is_done').notNull().default(false),
    /** Когда отметили выполненной. */
    doneAt: timestamp('done_at', { withTimezone: true }),
    /** Кто отметил выполненной. */
    doneByUserId: uuid('done_by_user_id'),

    /**
     * Когда отправить push-напоминание (накануне даты в 09:00 пояса организации).
     * NULL — не запрошено, нет даты, или момент уже в прошлом на момент создания/правки.
     */
    remindAt: timestamp('remind_at', { withTimezone: true }),
    /** Когда напоминание фактически отправлено (повторно не шлём). */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    // Для сетки календаря: задачи с датой в месяце.
    index('tasks_tenant_due_idx').on(t.tenantId, t.dueDate).where(sql`deleted_at IS NULL`),
    // Для «моих задач» инженера.
    index('tasks_tenant_assignee_idx')
      .on(t.tenantId, t.assigneeUserId)
      .where(sql`deleted_at IS NULL`),
  ],
);
