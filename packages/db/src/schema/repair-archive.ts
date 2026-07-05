/**
 * Архив ремонтов (repair_archive) — технический справочник «как чинили раньше».
 *
 * Назначение:
 *   - Флагманская AI-диагностика по симптому: при приёме/в карточке заявки
 *     показываем ПОХОЖИЕ прошлые ремонты (модель · симптом · что нашли · что делали · год).
 *   - Наполняется одноразовой загрузкой из архива WinServisePro (~4300 ремонтов 2015–2023,
 *     см. src/import-repair-archive.ts). В будущем сюда же можно доливать закрытые заявки.
 *
 * ⚠️ 152-ФЗ / ПДн: таблица содержит ТОЛЬКО техническую информацию.
 *   НЕТ ФИО/телефонов/адресов клиента, НЕТ ссылок на clients/assets/users.
 *   symptom в старой базе помечен как «со слов клиента» и НЕ является ПДн.
 *   `source_ref` — внутренний номер исходного ремонта (например «WSP-1234»), без ПДн.
 *
 * Поиск: по ключевым словам симптома + токенам модели, через ILIKE с явной
 *   COLLATE "ru-x-icu" (в C-локали обычный lower() не сворачивает кириллицу — см.
 *   kb-articles/repository.ts). Trigram не нужен: 4300 строк сканируются мгновенно,
 *   а pg_trgm на кириллице в C-локали всё равно даёт 0.
 */
import { index, integer, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { pk, tenantId, timestamps } from './_shared';

export const repairArchive = pgTable(
  'repair_archive',
  {
    id: pk(),
    tenantId: tenantId(),
    /** Ссылка на исходный ремонт (например «WSP-1234»). Без ПДн. Ключ идемпотентности загрузки. */
    sourceRef: varchar('source_ref', { length: 40 }).notNull(),
    /** Модель техники (свободный текст, как в старой базе). */
    deviceModel: varchar('device_model', { length: 300 }),
    manufacturer: varchar('manufacturer', { length: 200 }),
    /** Тип оборудования (УЗИ, рентген, ИВЛ…). */
    deviceType: varchar('device_type', { length: 200 }),
    /** Симптом со слов клиента (в WinServisePro — DISREPAIRFROMCLIENT). НЕ ПДн. */
    symptom: text('symptom'),
    /** Что нашли — обнаруженная неисправность (DISREPAIR). */
    diagnosis: text('diagnosis'),
    /** Что делали — перечень работ/запчастей через «; » (из WORKRECORD/DETAILRECORD). */
    worksSummary: text('works_summary'),
    /** Год ремонта. */
    year: integer('year'),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (t) => [
    index('repair_archive_tenant_idx').on(t.tenantId),
    // Идемпотентность загрузки: один исходный ремонт = одна строка на tenant.
    uniqueIndex('repair_archive_tenant_source_idx').on(t.tenantId, t.sourceRef),
  ],
);

export type RepairArchiveRow = typeof repairArchive.$inferSelect;
