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

    /**
     * Текущий владелец-клиент. ОПЦИОНАЛЬНО (см. миграцию 0059):
     * NULL — техника «без привязки к клиенту» (собственный парк сервиса, демо-аппараты,
     * склад до продажи). FK на clients(id) с ON DELETE RESTRICT остаётся — нельзя удалить
     * клиента, у которого есть техника; NULL внешним ключом просто не проверяется.
     */
    ownerClientId: uuid('owner_client_id'),

    /**
     * Ссылка на модель из каталога (asset_models). Опционально:
     * NULL — техника заведена «по-старому» свободным текстом (исторические записи
     * и быстрый ввод без каталога). При выборе модели из каталога сюда пишется её id,
     * а денормализованные model/manufacturer всё равно копируются в строки ниже —
     * чтобы карточка/печать/поиск работали без join'а и переживали правку каталога.
     */
    assetModelId: uuid('asset_model_id'),

    model: varchar('model', { length: 200 }).notNull(),
    /** Производитель (Philips, Drager, Mindray и т.п.). Plain varchar, не справочник. */
    manufacturer: varchar('manufacturer', { length: 200 }),
    /** Тип/категория аппарата (УЗИ, рентген, отсасыватель, автоклав…). Свободный текст с подсказками. */
    deviceType: varchar('device_type', { length: 100 }),
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
    index('assets_tenant_model_ref_idx').on(t.tenantId, t.assetModelId),
  ],
);

/**
 * Каталог моделей техники (справочник типов аппаратов), не привязанный к клиенту.
 * Заполняется один раз и переиспользуется: при заведении единицы техники или
 * создании заявки модель выбирается отсюда, а серийный/инвентарный номер вводится
 * для конкретного экземпляра (assets).
 *
 * Дубли по (manufacturer, model) предотвращаются в сервисе (case-insensitive
 * find-or-create) — на уровне БД жёсткой уникальности нет из-за локали «C»
 * и кириллицы (см. lib/ru-search.ts).
 */
export const assetModels = pgTable(
  'asset_models',
  {
    id: pk(),
    tenantId: tenantId(),

    /** Производитель (Philips, Drager, Mindray…). Опционально. */
    manufacturer: varchar('manufacturer', { length: 200 }),
    /** Тип/категория аппарата (УЗИ, рентген, отсасыватель…). Подставляется в технику при выборе модели. */
    deviceType: varchar('device_type', { length: 100 }),
    /** Название модели (Mindray DC-70, Tuttnauer 3870EA…). Обязательно. */
    model: varchar('model', { length: 200 }).notNull(),
    /** 1 / 2а / 2б / 3 по Росздравнадзору — подсказка по умолчанию для новой единицы. */
    riskClass: medDeviceRiskClassEnum('risk_class'),
    /** Категория аттестации инженеров, обычно требуемая для этой модели. Опционально. */
    requiredAttestationCategory: varchar('required_attestation_category', { length: 100 }),
    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    index('asset_models_tenant_model_idx').on(t.tenantId, t.model),
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
