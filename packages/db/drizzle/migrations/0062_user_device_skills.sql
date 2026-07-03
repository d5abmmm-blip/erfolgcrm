-- Навыки инженера: какие типы техники он обслуживает (УЗИ, рентген, автоклав…).
-- Связка user ↔ device_type. Используется для умного назначения заявок и на доске.
-- RLS включается отдельно (0062_enable_rls_user_device_skills.sql, setup-rls.ts).

CREATE TABLE IF NOT EXISTS "user_device_skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "device_type" varchar(100) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_device_skills_uniq"
  ON "user_device_skills" ("tenant_id", "user_id", "device_type");

CREATE INDEX IF NOT EXISTS "user_device_skills_type_idx"
  ON "user_device_skills" ("tenant_id", "device_type");
