/**
 * Лиды — воронка продаж (перенос из v1 project_2, таблица `leads`).
 *
 * Lead проходит стадии new → contacted → proposal → negotiation → won/lost
 * (переходы валидируются стейт-машиной leadTransitions из @erfolg/shared).
 * При выигрыше (won) лид может быть сконвертирован в client — тогда
 * convertedClientId/convertedAt заполняются в одной транзакции.
 *
 * score — расчётный приоритет 0..100 (см. calculateLeadScore из @erfolg/shared),
 * пересчитывается на каждом create/update.
 *
 * Ответственный менеджер хранится как assigned_user_id (users.id); отображаемое
 * имя резолвится join'ом на уровне DTO — денормализованного имени не держим (стиль v2).
 */
import {
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pk, tenantId, timestamps } from './_shared';

export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'contacted',
  'proposal',
  'negotiation',
  'won',
  'lost',
]);

export const leadSourceEnum = pgEnum('lead_source', [
  'cold_call',
  'referral',
  'tender',
  'website',
  'other',
]);

export const leadLostReasonEnum = pgEnum('lead_lost_reason', [
  'price',
  'competitor',
  'no_need',
  'no_response',
  'other',
]);

export const leads = pgTable(
  'leads',
  {
    id: pk(),
    tenantId: tenantId(),

    name: varchar('name', { length: 255 }).notNull(),
    contactPerson: varchar('contact_person', { length: 255 }),
    phone: varchar('phone', { length: 64 }),
    email: varchar('email', { length: 320 }),
    address: text('address'),
    region: varchar('region', { length: 128 }),

    status: leadStatusEnum('status').notNull().default('new'),
    source: leadSourceEnum('source').notNull().default('other'),

    /** Потенциальная сумма сделки, руб. */
    estimatedValue: numeric('estimated_value', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),

    /** Ответственный менеджер (users.id). Имя резолвится join'ом в DTO. */
    assignedUserId: uuid('assigned_user_id'),

    notes: text('notes'),
    nextAction: text('next_action'),
    nextActionDate: date('next_action_date'),

    /** Расчётный приоритет 0..100 (см. calculateLeadScore). */
    score: integer('score').notNull().default(0),

    lostReason: leadLostReasonEnum('lost_reason'),
    lostComment: text('lost_comment'),

    /** Если лид сконвертирован — ссылка на созданного клиента (clients.id). */
    convertedClientId: uuid('converted_client_id'),
    convertedAt: timestamp('converted_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    index('leads_tenant_status_idx')
      .on(t.tenantId, t.status)
      .where(sql`deleted_at IS NULL`),
    index('leads_tenant_created_idx')
      .on(t.tenantId, t.createdAt)
      .where(sql`deleted_at IS NULL`),
    index('leads_tenant_assigned_idx')
      .on(t.tenantId, t.assignedUserId)
      .where(sql`deleted_at IS NULL`),
  ],
);
