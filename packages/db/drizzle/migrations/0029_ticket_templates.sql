-- Шаблоны заявок (ticket_templates).
--
-- Бизнес-цель: менеджер при создании тикета жмёт «По шаблону» (например
-- «Замена термопасты», «Калибровка тонометра», «ТО монитора пациента»),
-- и автоматически заполняются работы / типовые запчасти / оценка времени.
--
-- Структура:
--   name                       — короткое имя (показывается в выборе)
--   description                — что входит, для подсказки менеджеру
--   default_repair_type        — paid / warranty / service_contract (NULL — не менять)
--   default_priority           — low / normal / high / urgent (NULL — не менять)
--   default_estimated_minutes  — оценка трудозатрат (15..720, NULL — не менять)
--   lines                      — jsonb массив строк наряда (см. service.ts)
--   archived_at                — soft archive (не показывать в выборе, но видно в /templates)
--
-- Уникальность: один tenant не может иметь двух АКТИВНЫХ шаблонов с одинаковым именем.
-- Архивные дубликаты допустимы (история).

CREATE TABLE "ticket_templates" (
  "id"                          uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"                   uuid NOT NULL,
  "name"                        varchar(200) NOT NULL,
  "description"                 text,
  "default_repair_type"         repair_type,
  "default_priority"            ticket_priority,
  "default_estimated_minutes"   integer,
  "lines"                       jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by_user_id"          uuid,
  "archived_at"                 timestamptz,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ticket_templates_user_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "ticket_templates_estimated_minutes_check"
    CHECK ("default_estimated_minutes" IS NULL
           OR ("default_estimated_minutes" >= 1 AND "default_estimated_minutes" <= 720))
);--> statement-breakpoint

-- Уникальность имени среди НЕархивных шаблонов одного tenant'а.
CREATE UNIQUE INDEX "ticket_templates_tenant_name_active_uniq"
  ON "ticket_templates" ("tenant_id", lower("name"))
  WHERE "archived_at" IS NULL;--> statement-breakpoint

-- Индекс под list (фильтр по tenant + сортировка по имени).
CREATE INDEX "ticket_templates_tenant_archived_idx"
  ON "ticket_templates" ("tenant_id", "archived_at");
