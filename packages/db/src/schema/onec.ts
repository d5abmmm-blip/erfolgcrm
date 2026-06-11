/**
 * Этап 8.F — Обмен с 1С.
 *
 * onec_exchange_log — append-only журнал всех обменов (экспорт счетов + импорт оплат).
 * onec_configs — per-tenant конфиг: токен входящего webhook'а, тайм-зона экспорта.
 *
 * Аутентификация входящих платежей: bearer Token, hash хранится (sha256). Сам токен показывается
 * только один раз при генерации (через UI 1С-настроек).
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pk, tenantId } from './_shared';

export const onecExchangeDirectionEnum = pgEnum('onec_exchange_direction', [
  'export',
  'import',
]);

export const onecExchangeStatusEnum = pgEnum('onec_exchange_status', [
  'pending',
  'success',
  'failed',
  'partial',
]);

export interface OnecExchangePayload {
  /** Список UUID invoices для export, или batch payment-records для import. */
  ids?: string[];
  /** Дополнительные параметры (since-дата, фильтры). */
  options?: Record<string, unknown>;
}

export interface OnecExchangeResult {
  processedIds?: string[];
  errors?: Array<{ id?: string; message: string }>;
  /** XML-байтов сгенерировано (для export). */
  xmlSize?: number;
}

export const onecExchangeLog = pgTable(
  'onec_exchange_log',
  {
    id: pk(),
    tenantId: tenantId(),
    direction: onecExchangeDirectionEnum('direction').notNull(),
    /** Free-form идентификатор операции: 'invoices_export', 'payments_import', 'manual'. */
    kind: varchar('kind', { length: 50 }).notNull(),
    status: onecExchangeStatusEnum('status').notNull().default('pending'),
    payload: jsonb('payload').$type<OnecExchangePayload>(),
    result: jsonb('result').$type<OnecExchangeResult>(),
    errorMessage: text('error_message'),
    processedCount: integer('processed_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('onec_exchange_log_tenant_started_idx').on(t.tenantId, sql`${t.startedAt} DESC`),
    index('onec_exchange_log_tenant_status_idx')
      .on(t.tenantId, t.status)
      .where(sql`status IN ('failed', 'partial')`),
  ],
);

export const onecConfigs = pgTable('onec_configs', {
  tenantId: tenantId().primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  /** SHA-256 hex от bearer-токена. Сам токен показывается один раз при генерации. */
  incomingTokenHash: varchar('incoming_token_hash', { length: 64 }),
  exportTimezone: varchar('export_timezone', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
