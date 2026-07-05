-- Архив ремонтов (repair_archive) — технический справочник «как чинили раньше».
--
-- Флагманская AI-диагностика по симптому: показываем похожие прошлые ремонты
-- (модель · симптом · что нашли · что делали · год). Наполняется одноразовой
-- загрузкой из архива WinServisePro (src/import-repair-archive.ts).
--
-- ⚠️ Без ПДн: только техника (модель/симптом/диагноз/работы/год). Нет ФИО/тел/адресов,
-- нет FK на clients/assets/users. source_ref — внутренний № исходного ремонта (WSP-<id>).
--
-- Поиск — ILIKE с COLLATE "ru-x-icu" по симптому/диагнозу/работам (см. репозиторий).
-- Trigram-индекс не заводим: 4300 строк сканируются мгновенно, а pg_trgm на кириллице
-- в C-локали всё равно бесполезен.

CREATE TABLE "repair_archive" (
  "id"             uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"      uuid NOT NULL,
  "source_ref"     varchar(40) NOT NULL,
  "device_model"   varchar(300),
  "manufacturer"   varchar(200),
  "device_type"    varchar(200),
  "symptom"        text,
  "diagnosis"      text,
  "works_summary"  text,
  "year"           integer,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX "repair_archive_tenant_idx"
  ON "repair_archive" ("tenant_id");--> statement-breakpoint

-- Идемпотентность загрузки: один исходный ремонт = одна строка на tenant.
CREATE UNIQUE INDEX "repair_archive_tenant_source_idx"
  ON "repair_archive" ("tenant_id", "source_ref");
