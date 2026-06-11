/**
 * Трейд-ин (перенос из v1 project_2, таблица `trade_in_items`).
 *
 * Приём б/у техники в зачёт: received → assessed → in_stock → sold / scrapped.
 * Статус sold выставляется ТОЛЬКО через complete-команду (service) — она атомарно
 * переносит владельца привязанной единицы техники (assets.owner_client_id +
 * событие owner_change в asset_events).
 *
 * Деньги — bigint копейки (конвенция v2):
 *   purchase — сколько зачли клиенту при приёме;
 *   assessed — оценочная стоимость после дефектовки;
 *   sale     — фактическая цена продажи (NULL пока не продано).
 *
 * Имена клиента/покупателя НЕ денормализуются (join на clients).
 * Фото — через общий модуль attachments (reference_type='trade_in'), своей колонки нет.
 */
import {
  bigint,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pk, tenantId, timestamps } from './_shared';

export const tradeInConditionEnum = pgEnum('trade_in_condition', [
  'excellent',
  'good',
  'fair',
  'poor',
]);

export const tradeInStatusEnum = pgEnum('trade_in_status', [
  'received',
  'assessed',
  'in_stock',
  'sold',
  'scrapped',
]);

export const tradeInItems = pgTable(
  'trade_in_items',
  {
    id: pk(),
    tenantId: tenantId(),

    /** Человекочитаемое название позиции («ИВЛ Hamilton C2, 2019»). */
    name: varchar('name', { length: 255 }).notNull(),
    manufacturer: varchar('manufacturer', { length: 200 }),
    model: varchar('model', { length: 200 }),
    serialNumber: varchar('serial_number', { length: 100 }),
    year: integer('year'),

    condition: tradeInConditionEnum('condition').notNull().default('good'),
    status: tradeInStatusEnum('status').notNull().default('received'),

    /** Кто сдал технику в зачёт. */
    clientId: uuid('client_id'),
    /** Покупатель (обязателен для complete). */
    buyerClientId: uuid('buyer_client_id'),
    /** Если единица заведена в парк — перенос владельца при complete. */
    assetId: uuid('asset_id'),

    purchasePriceKopecks: bigint('purchase_price_kopecks', { mode: 'bigint' })
      .notNull()
      .default(0n),
    assessedPriceKopecks: bigint('assessed_price_kopecks', { mode: 'bigint' })
      .notNull()
      .default(0n),
    salePriceKopecks: bigint('sale_price_kopecks', { mode: 'bigint' }),

    notes: text('notes'),

    receivedAt: date('received_at').notNull(),
    soldAt: date('sold_at'),

    ...timestamps,
  },
  (t) => [
    index('trade_in_tenant_status_idx')
      .on(t.tenantId, t.status)
      .where(sql`deleted_at IS NULL`),
    index('trade_in_tenant_received_idx')
      .on(t.tenantId, t.receivedAt)
      .where(sql`deleted_at IS NULL`),
  ],
);
