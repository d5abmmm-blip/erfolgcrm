/**
 * Этап 5 — Финансы Lite. Платежи по заявкам.
 *
 * Связан с tickets (ON DELETE CASCADE: удалили заявку — удалили платежи).
 * work_orders.paid_amount_kopecks материализован — пересчитывается при insert/delete payment.
 *
 * До интеграции с 1С (Этап 8) этот модуль — основной учёт оплаты.
 * Все суммы в копейках (bigint).
 */
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId } from './_shared';

/** Зеркало PaymentMethod из @erfolg/shared */
export const paymentMethodEnum = pgEnum('payment_method', [
  'cash',
  'card',
  'bank_transfer',
]);

export const payments = pgTable(
  'payments',
  {
    id: pk(),
    tenantId: tenantId(),
    ticketId: fkUuid('ticket_id'),
    /**
     * Этап 8.B — опциональная привязка к счёту (invoices.id).
     * NULL = «свободный» платёж по тикету (старый поток до Этапа 8).
     * NOT NULL = платёж по конкретному invoice → пересчитывает invoice.paid_amount.
     * CASCADE: удаление invoice убирает все связанные платежи (но в практике invoice не удаляется,
     * а отменяется через transitionToCancelled).
     */
    invoiceId: uuid('invoice_id'),
    amountKopecks: bigint('amount_kopecks', { mode: 'bigint' }).notNull(),
    method: paymentMethodEnum('method').notNull().default('cash'),
    /** Когда фактически оплачено. */
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    comment: text('comment'),
    /** Кто внёс запись. SET NULL при удалении пользователя. */
    userId: uuid('user_id'),
    /**
     * Идемпотентность импорта из 1С: внешний идентификатор платежа (UUID или строка-номер
     * из 1С). UNIQUE-индекс (tenant_id, invoice_id, external_payment_id) гарантирует, что
     * повторный webhook с тем же external id не создаст дубль. NULL — для платежей,
     * введённых вручную в CRM (никакого ограничения на них нет).
     * Миграция добавляющая колонку и индекс — отдельная задача (см. follow-up).
     */
    externalPaymentId: text('external_payment_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_tenant_ticket_idx').on(t.tenantId, t.ticketId, t.paidAt),
    index('payments_tenant_invoice_idx')
      .on(t.tenantId, t.invoiceId)
      .where(sql`invoice_id IS NOT NULL`),
    check('payments_amount_pos', sql`${t.amountKopecks} > 0`),
  ],
);
