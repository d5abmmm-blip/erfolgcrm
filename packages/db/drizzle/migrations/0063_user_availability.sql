-- Занятость инженера: выходной / отпуск / на выезде — интервал дат.
-- Подсказка на доске «По инженеру» (НЕ блокирует назначение).
-- RLS включается отдельно (0063_enable_rls_user_availability.sql, setup-rls.ts).

DO $$ BEGIN
  CREATE TYPE "user_availability_kind" AS ENUM ('day_off', 'vacation', 'onsite');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "user_availability" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "kind" "user_availability_kind" NOT NULL,
  "date_from" date NOT NULL,
  "date_to" date NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_availability_user_idx"
  ON "user_availability" ("tenant_id", "user_id", "date_from");
