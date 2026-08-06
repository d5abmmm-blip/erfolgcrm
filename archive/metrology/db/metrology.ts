/**
 * Stage 10'.F — Метрология (поверки СИ).
 *
 * Бизнес-модель:
 *   - metrology_si_details — singleton-расширение к assets для тех экземпляров,
 *     которые являются Средствами Измерений (СИ). Один-к-одному с assets,
 *     PK = asset_id. Содержит метрологические атрибуты + last/next calibrationAt
 *     (вычисляемые от добавленных calibrations).
 *   - metrology_calibrations — журнал поверок: дата, № свидетельства, поверитель,
 *     результат, ссылка на attachment с PDF протоколом.
 *
 * Госрегулирование:
 *   - 102-ФЗ "Об обеспечении единства измерений": СИ, применяемые в сфере
 *     госрегулирования (медицина — да), подлежат периодической поверке.
 *   - Росздравнадзор требует журнал поверок для медтехники из реестра СИ.
 */
import {
  date,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

export const metrologyCalibrationResultEnum = pgEnum('metrology_calibration_result', [
  'passed',
  'failed',
]);

/**
 * Метрологические атрибуты СИ. Singleton: один ассет — одна запись.
 * При создании синхронно проставляется assets.requires_metrology = true.
 */
export const metrologySiDetails = pgTable(
  'metrology_si_details',
  {
    /** PK = FK на assets.id (CASCADE delete). */
    assetId: uuid('asset_id').primaryKey().notNull(),
    tenantId: tenantId(),

    /** Наименование типа СИ ("Манометр МПЭ-3У") — из Госреестра. */
    typeName: varchar('type_name', { length: 200 }).notNull(),
    /** № в Госреестре СИ ("12345-67"). */
    patternRegistryNumber: varchar('pattern_registry_number', { length: 50 }),
    /** Класс точности ("0.6", "1.5", "II"). */
    accuracyClass: varchar('accuracy_class', { length: 50 }),
    /** Диапазон измерений ("0…600 мм рт. ст."). */
    measurementRange: varchar('measurement_range', { length: 200 }),
    /** Межповерочный интервал в месяцах (обычно 12). */
    calibrationIntervalMonths: smallint('calibration_interval_months').notNull(),

    /** Дата последней успешной поверки. NULL пока не было. */
    lastCalibrationAt: date('last_calibration_at'),
    /** Дата следующей поверки. NULL пока не было первой поверки. */
    nextCalibrationAt: date('next_calibration_at'),

    ...timestamps,
  },
  (t) => [index('metrology_si_details_tenant_next_idx').on(t.tenantId, t.nextCalibrationAt)],
);

/**
 * Журнал поверок. Каждая запись = одно событие поверки (passed/failed).
 * При insert: пересчитываем lastCalibrationAt и nextCalibrationAt в metrology_si_details.
 */
export const metrologyCalibrations = pgTable(
  'metrology_calibrations',
  {
    id: pk(),
    tenantId: tenantId(),
    assetId: fkUuid('asset_id'),

    /** Дата проведения поверки. */
    performedAt: date('performed_at').notNull(),
    /** Действительна до (из свидетельства). */
    validUntil: date('valid_until').notNull(),
    /** № свидетельства о поверке. */
    certificateNumber: varchar('certificate_number', { length: 100 }),
    /** Организация-поверитель. */
    calibratorOrg: varchar('calibrator_org', { length: 300 }),
    result: metrologyCalibrationResultEnum('result').notNull(),
    notes: text('notes'),
    /** Опциональная ссылка на attachment с PDF протоколом. */
    documentAttachmentId: uuid('document_attachment_id'),

    ...timestamps,
  },
  (t) => [
    index('metrology_calibrations_tenant_asset_idx').on(t.tenantId, t.assetId, t.performedAt),
  ],
);

/**
 * Stage 10'.G — анти-спам лог.
 * Одна запись на (tenant, user, sent_on, channel) — гарантирует что воркер
 * metrology-reminder отправит email/push не более одного раза в сутки одному получателю.
 */
export const metrologyReminderLog = pgTable(
  'metrology_reminder_log',
  {
    id: pk(),
    tenantId: tenantId(),
    userId: fkUuid('user_id'),
    sentOn: date('sent_on').notNull(),
    /** 'email' | 'push'. По умолчанию 'email' — основной канал для директора/диспетчера. */
    channel: varchar('channel', { length: 20 }).notNull().default('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('metrology_reminder_log_unique_per_day').on(
      t.tenantId,
      t.userId,
      t.sentOn,
      t.channel,
    ),
    index('metrology_reminder_log_tenant_sent_idx').on(t.tenantId, t.sentOn),
  ],
);
