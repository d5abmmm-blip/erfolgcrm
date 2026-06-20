/**
 * Продажи — продажа/заказ запчастей и оборудования клиенту (отдельно от ремонтных заявок).
 *
 * Заказ (sales) с позициями (sale_items). Путь статусов:
 *   new → ordered (заказано у поставщика) → received (получено) → handed_over (выдано),
 *   плюс cancelled. total_kopecks материализован (Σ позиций), пересчитывается в
 *   sales/repository.ts при изменении позиций.
 *
 * Деньги — bigint копейки. Оплата клиентом проводится в кассу как доход (статья
 * «Продажа запчастей») по кнопке «Принять оплату»: cash_transaction_id хранит ссылку,
 * отмена оплаты мягко удаляет операцию (как payroll_payouts). purchase_cost_kopecks —
 * опциональная закупка у поставщика (для маржи).
 *
 * RLS включается отдельно через 0052_enable_rls_sales.sql (setup-rls.ts).
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
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

export const saleStatusEnum = pgEnum('sale_status', [
  'new',
  'ordered',
  'received',
  'handed_over',
  'cancelled',
]);

export const sales = pgTable(
  'sales',
  {
    id: pk(),
    tenantId: tenantId(),
    /** Сквозной номер заказа per tenant (для ссылки «Заказ №5»). */
    saleNo: integer('sale_no').notNull(),
    clientId: fkUuid('client_id'),
    status: saleStatusEnum('status').notNull().default('new'),
    /** Поставщик (свободный текст, опционально). */
    supplier: varchar('supplier', { length: 200 }),
    /** Закупочная стоимость у поставщика (опц., для маржи). */
    purchaseCostKopecks: bigint('purchase_cost_kopecks', { mode: 'bigint' }).notNull().default(0n),
    /** Материализованная сумма продажи (Σ позиций). Пересчёт в sales/repository.ts. */
    totalKopecks: bigint('total_kopecks', { mode: 'bigint' }).notNull().default(0n),
    comment: text('comment'),
    /** Оплата клиентом → касса. Заполняется при «Принять оплату». */
    paidOn: date('paid_on'),
    accountId: uuid('account_id'),
    cashTransactionId: uuid('cash_transaction_id'),
    createdBy: uuid('created_by'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sales_tenant_no_uniq').on(t.tenantId, t.saleNo).where(sql`deleted_at IS NULL`),
    index('sales_tenant_status_idx').on(t.tenantId, t.status).where(sql`deleted_at IS NULL`),
    index('sales_tenant_client_idx').on(t.tenantId, t.clientId).where(sql`deleted_at IS NULL`),
    index('sales_tenant_created_idx').on(t.tenantId, t.createdAt).where(sql`deleted_at IS NULL`),
    check('sales_amounts_non_negative', sql`total_kopecks >= 0 AND purchase_cost_kopecks >= 0`),
  ],
);

export const saleItems = pgTable(
  'sale_items',
  {
    id: pk(),
    tenantId: tenantId(),
    saleId: fkUuid('sale_id'),
    name: varchar('name', { length: 255 }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitPriceKopecks: bigint('unit_price_kopecks', { mode: 'bigint' }).notNull().default(0n),
    /** Закупочная цена за единицу (за сколько купили). 0 — не указана. Для маржи. */
    unitCostKopecks: bigint('unit_cost_kopecks', { mode: 'bigint' }).notNull().default(0n),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sale_items_tenant_sale_idx').on(t.tenantId, t.saleId),
    check('sale_items_qty_pos', sql`quantity > 0`),
    check('sale_items_price_non_negative', sql`unit_price_kopecks >= 0`),
    check('sale_items_cost_non_negative', sql`unit_cost_kopecks >= 0`),
  ],
);
