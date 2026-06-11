/**
 * Парк техники клиентов и хронология её состояний.
 *
 * assets — единица оборудования (УЗИ, автоклав, ЭКГ и т.п.).
 *   Класс риска по Росздравнадзору (1, 2а, 2б, 3) — дублирует zod-енум из @erfolg/shared.
 *
 * asset_events — append-only журнал изменений: создание, смена статуса/владельца/локации,
 *   ручные заметки. Сервис автоматически записывает event при изменении соответствующего
 *   поля в assets (бизнес-инвариант, см. assets/service.ts).
 */
import {
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

/** Класс риска медицинского изделия (зеркалит MedDeviceRiskClass из @erfolg/shared) */
export const medDeviceRiskClassEnum = pgEnum('med_device_risk_class', ['1', '2a', '2b', '3']);

export const assetLifecycleEnum = pgEnum('asset_lifecycle_status', [
  'in_service',
  'in_repair',
  'awaiting_parts',
  'reserve',
  'decommissioned',
]);

export const assetEventTypeEnum = pgEnum('asset_event_type', [
  'created',
  'status_change',
  'owner_change',
  'location_change',
  'note',
]);

export const assets = pgTable(
  'assets',
  {
    id: pk(),
    tenantId: tenantId(),

    /** Текущий владелец. ON DELETE RESTRICT — нельзя удалить клиента, если у него есть техника. */
    ownerClientId: fkUuid('owner_client_id'),

    model: varchar('model', { length: 200 }).notNull(),
    /** Производитель (Philips, Drager, Mindray и т.п.). Plain varchar, не справочник. */
    manufacturer: varchar('manufacturer', { length: 200 }),
    serialNumber: varchar('serial_number', { length: 100 }),
    /** Инвентарный номер у клиента (для бюджетников критично) */
    inventoryNumber: varchar('inventory_number', { length: 50 }),
    /** Где физически находится у клиента (кабинет, корпус) */
    location: text('location'),

    commissionedAt: date('commissioned_at'),
    warrantyUntil: date('warranty_until'),

    lifecycleStatus: assetLifecycleEnum('lifecycle_status').notNull().default('in_service'),
    /** 1 / 2а / 2б / 3 по Росздравнадзору. Опционально, заполняется не всегда сразу. */
    riskClass: medDeviceRiskClassEnum('risk_class'),
    /**
     * Stage 10'.I — Категория аттестации инженеров, требуемая для обслуживания.
     * NULL ⇒ требование не задано (никакой проверки при назначении).
     * Иначе — диспетчер увидит предупреждение, если назначить инженера без
     * действующей аттестации по этой категории. Жёсткой блокировки нет
     * (бывают срочные вызовы) — решение остаётся за диспетчером.
     */
    requiredAttestationCategory: varchar('required_attestation_category', { length: 100 }),

    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    index('assets_tenant_owner_idx').on(t.tenantId, t.ownerClientId),
    index('assets_tenant_serial_idx').on(t.tenantId, t.serialNumber),
    index('assets_tenant_status_idx').on(t.tenantId, t.lifecycleStatus),
  ],
);

/**
 * Append-only событийный лог. Без updatedAt/deletedAt — события не правят и не удаляют.
 * payload — гибкий jsonb с from/to/comment в зависимости от типа события.
 */
export interface AssetEventPayload {
  from?: unknown;
  to?: unknown;
  comment?: string;
}

export const assetEvents = pgTable(
  'asset_events',
  {
    id: pk(),
    tenantId: tenantId(),
    assetId: fkUuid('asset_id'),
    /** Кто сделал. NULL для системных событий (cron, миграции). */
    userId: uuid('user_id'),
    type: assetEventTypeEnum('type').notNull(),
    payload: jsonb('payload').$type<AssetEventPayload>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('asset_events_tenant_asset_idx').on(t.tenantId, t.assetId, t.createdAt),
  ],
);
