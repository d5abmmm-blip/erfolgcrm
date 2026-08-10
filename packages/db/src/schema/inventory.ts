/**
 * Этап 5 — Склад с FEFO-выдачей.
 *
 * Модель данных:
 *   - inventory_items — справочник товаров (запчасти, расходники).
 *   - inventory_batches — партии прихода. Остаток (quantity_remaining) уменьшается
 *     при outbound/writeoff. NEVER trust client; всегда SELECT FOR UPDATE.
 *   - inventory_movements — append-only журнал движений (inbound/outbound/adjustment/writeoff).
 *     Никаких UPDATE/DELETE — это аудит.
 *
 * FEFO (First-Expire-First-Out): при outbound выбираем партии с наименьшим
 * expires_at (NULLS LAST — без срока годности уходят последними), затем по received_at.
 * Партиальный индекс idx_inventory_batches_fefo заточен под этот запрос.
 *
 * Денежные значения — bigint в копейках (см. work_orders).
 */
import {
  bigint,
  check,
  index,
  numeric,
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

/** Зеркало InventoryMovementKind из @erfolg/shared */
export const inventoryMovementKindEnum = pgEnum('inventory_movement_kind', [
  'inbound',
  'outbound',
  'adjustment',
  'writeoff',
]);

/** Зеркало InventoryReferenceType из @erfolg/shared */
export const inventoryReferenceTypeEnum = pgEnum('inventory_reference_type', [
  'work_order_line',
  'manual',
]);

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: pk(),
    tenantId: tenantId(),
    name: varchar('name', { length: 300 }).notNull(),
    /** Артикул / SKU. Опционален, но уникален per tenant если задан. */
    sku: varchar('sku', { length: 100 }),
    manufacturer: varchar('manufacturer', { length: 200 }),
    /** Единица учёта: «шт», «упак», «м», «л». */
    unit: varchar('unit', { length: 20 }).notNull().default('шт'),
    /** Минимальный остаток для бейджа «низкий остаток». NUMERIC поддерживает дроби. */
    minStock: numeric('min_stock', { precision: 12, scale: 3 }).notNull().default('0'),
    category: varchar('category', { length: 100 }),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('inventory_items_tenant_sku_uniq')
      .on(t.tenantId, t.sku)
      .where(sql`${t.sku} IS NOT NULL`),
    index('inventory_items_tenant_name_idx').on(t.tenantId, t.name),
    index('inventory_items_tenant_category_idx').on(t.tenantId, t.category),
  ],
);

export const inventoryBatches = pgTable(
  'inventory_batches',
  {
    id: pk(),
    tenantId: tenantId(),
    itemId: fkUuid('item_id'),
    /** Код партии / номер накладной поставщика. Опционален. */
    batchCode: varchar('batch_code', { length: 100 }),
    /** Сколько пришло изначально. Не меняется. */
    quantityInitial: numeric('quantity_initial', { precision: 12, scale: 3 }).notNull(),
    /** Текущий остаток. Уменьшается при outbound/writeoff. */
    quantityRemaining: numeric('quantity_remaining', { precision: 12, scale: 3 }).notNull(),
    /** Себестоимость единицы в копейках. Для отчётов и средней цены. */
    unitCostKopecks: bigint('unit_cost_kopecks', { mode: 'bigint' }).notNull().default(0n),
    supplier: varchar('supplier', { length: 300 }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Срок годности. NULL = без срока (например, инструмент). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('inventory_batches_tenant_item_idx').on(t.tenantId, t.itemId),
    /**
     * Партиальный FEFO-индекс — мотор выборки в issueToWorkOrder.
     * NULLS LAST по expires_at: партии без срока годности уходят последними.
     * Условие quantity_remaining > 0 убирает «пустые» партии из плана запроса.
     */
    index('inventory_batches_fefo_idx')
      .on(t.tenantId, t.itemId, sql`${t.expiresAt} ASC NULLS LAST`, t.receivedAt)
      .where(sql`${t.quantityRemaining} > 0`),
    check('inventory_batches_qty_nonneg', sql`${t.quantityRemaining} >= 0`),
    check('inventory_batches_qty_le_initial', sql`${t.quantityRemaining} <= ${t.quantityInitial}`),
    check('inventory_batches_qty_initial_pos', sql`${t.quantityInitial} > 0`),
  ],
);

/**
 * Append-only журнал движений по складу.
 * - inbound: appearance of stock (mirror of inventoryBatches insert)
 * - outbound: расход (на наряд, ручное списание)
 * - adjustment: коррекция остатка (например после инвентаризации)
 * - writeoff: списание партии (просрочка, брак)
 *
 * Quantity знаковая: positive для inbound/adjustment+, negative для outbound/writeoff/adjustment-.
 * Это даёт single-source-of-truth для пересчёта остатков (SUM по item_id == quantity_remaining
 * по партиям — инвариант, можно проверять в тестах).
 */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: pk(),
    tenantId: tenantId(),
    itemId: fkUuid('item_id'),
    /** К какой партии. Может быть NULL для adjustment без привязки. */
    batchId: uuid('batch_id'),
    /** Знаковое: positive — приход, negative — расход/списание. */
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
    kind: inventoryMovementKindEnum('kind').notNull(),
    /** Откуда движение: строка наряда или ручная операция. */
    referenceType: inventoryReferenceTypeEnum('reference_type').notNull().default('manual'),
    /** ID связанной строки наряда / другой ссылки. Не FK (может быть удалён). */
    referenceId: uuid('reference_id'),
    /** Кто провёл. NULL для системных операций. */
    userId: uuid('user_id'),
    comment: text('comment'),
    /**
     * Ключ одного запроса списания (идемпотентный реплей офлайн-очереди).
     * Группа движений одного запроса (FEFO — несколько партий) несёт один ключ,
     * поэтому индекс НЕ уникальный; проверка «уже применён» — под advisory-замком
     * (issueToWorkOrderInTx). NULL — движение без ключа (десктоп/ручные/история).
     */
    clientRequestId: uuid('client_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('inventory_movements_tenant_item_idx').on(t.tenantId, t.itemId, t.createdAt),
    index('inventory_movements_tenant_ref_idx').on(t.tenantId, t.referenceType, t.referenceId),
    index('inventory_movements_client_request_idx')
      .on(t.tenantId, t.clientRequestId)
      .where(sql`${t.clientRequestId} IS NOT NULL`),
    check('inventory_movements_qty_nonzero', sql`${t.quantity} <> 0`),
  ],
);
