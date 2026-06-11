/**
 * Этап 5 — Журнал ТО (планы и факты техобслуживания).
 *
 * Бизнес-модель:
 *   - maintenance_schedules — план: что и как часто обслуживать (interval_days),
 *     когда последний раз делали (last_done_at) и когда следующее (next_due_at).
 *     При recordPerformed: last_done_at = performed_at, next_due_at = performed_at + interval.
 *   - maintenance_log — факт выполнения. Опционально привязан к ticket (если ТО шло через
 *     заявку) и к schedule (если плановое).
 *
 * Росздравнадзор требует журнал ТО для медтехники.
 */
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

/** Зеркало MaintenanceKind из @erfolg/shared */
export const maintenanceKindEnum = pgEnum('maintenance_kind', ['planned', 'urgent']);

export const maintenanceSchedules = pgTable(
  'maintenance_schedules',
  {
    id: pk(),
    tenantId: tenantId(),
    /** Какая техника обслуживается. CASCADE — без техники нет графика. */
    assetId: fkUuid('asset_id'),
    kind: maintenanceKindEnum('kind').notNull().default('planned'),
    /** Период между обслуживаниями в днях. > 0. */
    intervalDays: integer('interval_days').notNull(),
    /** Последняя дата фактического выполнения. NULL для свежих графиков. */
    lastDoneAt: timestamp('last_done_at', { withTimezone: true }),
    /** Следующий срок. Пересчитывается при recordPerformed. */
    nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull(),
    /** Ответственный за выполнение. NULL — не назначен. */
    responsibleUserId: uuid('responsible_user_id'),
    notes: text('notes'),
    /** Деактивирован: график не «горит» в дашборде, но история сохраняется. */
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('maintenance_schedules_tenant_asset_idx').on(t.tenantId, t.assetId),
    index('maintenance_schedules_tenant_due_idx')
      .on(t.tenantId, t.nextDueAt)
      .where(sql`${t.isActive} = true`),
  ],
);

export const maintenanceLog = pgTable(
  'maintenance_log',
  {
    id: pk(),
    tenantId: tenantId(),
    assetId: fkUuid('asset_id'),
    /** К какому графику относится. NULL — внеплановое ТО. */
    scheduleId: uuid('schedule_id'),
    /** Через какую заявку шло (если в работе с CRM). NULL — ручная запись. */
    ticketId: uuid('ticket_id'),
    performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Кто выполнил. NULL для импортированных историй. */
    performedByUserId: uuid('performed_by_user_id'),
    summary: varchar('summary', { length: 1000 }).notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('maintenance_log_tenant_asset_idx').on(t.tenantId, t.assetId, t.performedAt),
    index('maintenance_log_tenant_schedule_idx').on(t.tenantId, t.scheduleId),
  ],
);
