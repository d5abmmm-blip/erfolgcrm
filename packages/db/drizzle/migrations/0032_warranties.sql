-- Гарантии на технику (перенос из v1 project_2).
--
-- Реестр гарантий по единицам техники: заводская/сервисная/расширенная.
-- Клиент резолвится через assets.owner_client_id (join), денормализации нет.
--
-- Статус НЕ хранится (в v1 протухал): хранится только флаг voided,
-- действующий статус (active/expiring/expired/voided) вычисляется на чтении.
--
-- RLS включается отдельно через 0032_enable_rls_warranties.sql (запускается setup-rls.ts).

CREATE TYPE "public"."warranty_type" AS ENUM('manufacturer', 'service', 'extended');--> statement-breakpoint

CREATE TABLE "warranties" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "asset_id" uuid NOT NULL,
  "type" "warranty_type" NOT NULL DEFAULT 'manufacturer',
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "voided" boolean NOT NULL DEFAULT false,
  "coverage_description" text,
  "provider" varchar(255),
  "contract_number" varchar(128),
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "warranties_date_range" CHECK ("end_date" >= "start_date")
);--> statement-breakpoint

CREATE INDEX "warranties_tenant_asset_idx"
  ON "warranties" USING btree ("tenant_id", "asset_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "warranties_tenant_end_idx"
  ON "warranties" USING btree ("tenant_id", "end_date")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Гарантия без техники не имеет смысла: при удалении техники гарантии удаляются.
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;
