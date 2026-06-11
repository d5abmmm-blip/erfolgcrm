/**
 * Этап 8 — Финансы. Счета (invoices).
 *
 * Бизнес-модель — один счёт на один наряд (UNIQUE по (tenant_id, work_order_id) среди живых).
 * Сквозной номер через tenant_counters.kind='invoice' (формат "INV-2026-000017").
 *
 * Денежные суммы — snapshot на момент issued. После issue работа в work_order может уехать
 * (новые строки), но счёт у клиента остаётся «таким, каким его получил».
 *
 * paid_amount_kopecks — материализован: пересчитывается в payments/service.ts при insert/delete
 * платежа с invoice_id !== null (см. 8.B). Для draft счёта paid всегда 0.
 *
 * Все суммы в копейках (bigint). VAT считается «вкладной» (НДС включён в total_amount):
 *   vat_amount = round(total * rate / (100 + rate))
 * Это согласуется с pdf/invoice.ts (apps/web/src/lib/pdf/invoice.ts).
 */
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';
import { vatRateEnum } from './tickets';

/** Зеркало InvoiceStatus из @erfolg/shared. */
export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'cancelled',
]);

export const invoices = pgTable(
  'invoices',
  {
    id: pk(),
    tenantId: tenantId(),

    /** Сквозной номер вида "INV-2026-000017". Уникален среди живых per tenant. */
    invoiceNumber: varchar('invoice_number', { length: 30 }).notNull(),

    /** Клиент-плательщик. RESTRICT — нельзя удалить клиента со счетами. */
    clientId: fkUuid('client_id'),
    /** Заявка-источник (для удобной навигации). RESTRICT. */
    ticketId: fkUuid('ticket_id'),
    /** Наряд-источник. 1:1 (UNIQUE среди живых). RESTRICT. */
    workOrderId: fkUuid('work_order_id'),

    status: invoiceStatusEnum('status').notNull().default('draft'),
    vatRate: vatRateEnum('vat_rate').notNull().default('5'),

    /** Snapshot на момент issue. Для draft = текущие totals work_order. */
    totalAmountKopecks: bigint('total_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),
    vatAmountKopecks: bigint('vat_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),
    /** Материализованная сумма платежей. Пересчёт в payments/service.ts. */
    paidAmountKopecks: bigint('paid_amount_kopecks', { mode: 'bigint' }).notNull().default(0n),

    /** Drizzle date — string 'YYYY-MM-DD'. БД-уровневый default = CURRENT_DATE (см. миграция). */
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date').notNull(),

    notes: text('notes'),

    issuedAt: timestamp('issued_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),

    /** 8.E — последняя отправка email-напоминания. */
    lastReminderSentAt: timestamp('last_reminder_sent_at', { withTimezone: true }),
    reminderCount: integer('reminder_count').notNull().default(0),

    /** 8.F — выгрузка в 1С. */
    onecSyncedAt: timestamp('onec_synced_at', { withTimezone: true }),
    onecExternalId: varchar('onec_external_id', { length: 64 }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('invoices_tenant_number_uniq')
      .on(t.tenantId, t.invoiceNumber)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex('invoices_tenant_work_order_uniq')
      .on(t.tenantId, t.workOrderId)
      .where(sql`deleted_at IS NULL`),
    index('invoices_tenant_client_idx')
      .on(t.tenantId, t.clientId)
      .where(sql`deleted_at IS NULL`),
    index('invoices_tenant_ticket_idx')
      .on(t.tenantId, t.ticketId)
      .where(sql`deleted_at IS NULL`),
    index('invoices_tenant_status_idx')
      .on(t.tenantId, t.status)
      .where(sql`deleted_at IS NULL`),
    index('invoices_overdue_check_idx')
      .on(t.tenantId, t.dueDate)
      .where(
        sql`deleted_at IS NULL AND status IN ('issued', 'partially_paid', 'overdue')`,
      ),
    index('invoices_pending_onec_export_idx')
      .on(t.tenantId, t.updatedAt)
      .where(
        sql`deleted_at IS NULL AND onec_synced_at IS NULL AND status <> 'draft'`,
      ),
    check(
      'invoices_amounts_non_negative',
      sql`total_amount_kopecks >= 0 AND vat_amount_kopecks >= 0 AND paid_amount_kopecks >= 0`,
    ),
    check(
      'invoices_paid_not_exceeds_total',
      sql`paid_amount_kopecks <= total_amount_kopecks`,
    ),
    check(
      'invoices_vat_not_exceeds_total',
      sql`vat_amount_kopecks <= total_amount_kopecks`,
    ),
    check('invoices_due_after_issue', sql`due_date >= issue_date`),
  ],
);
