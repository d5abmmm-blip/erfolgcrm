/**
 * Занятость инженера — выходной / отпуск / на выезде на интервал дат.
 * Подсказка на доске «По инженеру» (бейдж), НЕ блокирует назначение.
 *
 * RLS включается отдельным *enable_rls*.sql (см. setup-rls.ts).
 */
import { date, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { pk, tenantId } from './_shared';

export const userAvailabilityKindEnum = pgEnum('user_availability_kind', [
  'day_off',
  'vacation',
  'onsite',
]);

export const userAvailability = pgTable(
  'user_availability',
  {
    id: pk(),
    tenantId: tenantId(),
    /** FK на users.id (app-enforced). */
    userId: uuid('user_id').notNull(),
    kind: userAvailabilityKindEnum('kind').notNull(),
    /** Интервал дат (включительно), в таймзоне организации. */
    dateFrom: date('date_from').notNull(),
    dateTo: date('date_to').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_availability_user_idx').on(t.tenantId, t.userId, t.dateFrom)],
);
