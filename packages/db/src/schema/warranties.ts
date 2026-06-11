/**
 * Гарантии на технику (перенос из v1 project_2, таблица `warranties`).
 *
 * Реестр гарантий: заводская (manufacturer), сервисная (service), расширенная (extended).
 * Привязана к единице техники (assets); клиент резолвится через assets.owner_client_id —
 * денормализованных имён не храним (в отличие от v1).
 *
 * ОТЛИЧИЕ ОТ v1: статус НЕ хранится. v1 хранил status (active/expiring/expired/voided),
 * который протухал (expiring/expired зависят от текущей даты). Здесь храним только флаг
 * voided (аннулирована вручную), а действующий статус вычисляется в SQL на чтении:
 *   voided → 'voided'; end_date < today → 'expired';
 *   end_date ≤ today+30 → 'expiring'; иначе 'active'.
 *
 * У assets есть простое поле warranty_until — этот реестр его супersedes (богаче:
 * тип/поставщик/№ договора/покрытие); поле остаётся для обратной совместимости карточки.
 */
import { boolean, check, date, index, pgEnum, pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

export const warrantyTypeEnum = pgEnum('warranty_type', [
  'manufacturer',
  'service',
  'extended',
]);

export const warranties = pgTable(
  'warranties',
  {
    id: pk(),
    tenantId: tenantId(),

    /** Единица техники. CASCADE — гарантия без техники не имеет смысла. */
    assetId: fkUuid('asset_id'),

    type: warrantyTypeEnum('type').notNull().default('manufacturer'),

    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),

    /** Аннулирована вручную (нарушение условий эксплуатации и т.п.). */
    voided: boolean('voided').notNull().default(false),

    /** Что покрывает гарантия (текст из договора/паспорта изделия). */
    coverageDescription: text('coverage_description'),
    /** Кто даёт гарантию: завод, дистрибьютор, наш СЦ. */
    provider: varchar('provider', { length: 255 }),
    /** Номер договора/гарантийного талона. */
    contractNumber: varchar('contract_number', { length: 128 }),

    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    index('warranties_tenant_asset_idx')
      .on(t.tenantId, t.assetId)
      .where(sql`deleted_at IS NULL`),
    index('warranties_tenant_end_idx')
      .on(t.tenantId, t.endDate)
      .where(sql`deleted_at IS NULL`),
    check('warranties_date_range', sql`end_date >= start_date`),
  ],
);
