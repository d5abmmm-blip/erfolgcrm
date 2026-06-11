-- Лиды — воронка продаж (перенос из v1 project_2).
--
-- Стадии: new → contacted → proposal → negotiation → won/lost.
-- Переходы валидируются стейт-машиной leadTransitions (@erfolg/shared) на уровне сервиса.
-- score (0..100) пересчитывается на create/update через calculateLeadScore.
-- При конвертации в клиента (status=won) заполняются converted_client_id/converted_at
-- в одной транзакции (см. modules/leads/service.ts).
--
-- RLS включается отдельно через 0031_enable_rls_leads.sql (запускается setup-rls.ts).

CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'proposal', 'negotiation', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('cold_call', 'referral', 'tender', 'website', 'other');--> statement-breakpoint
CREATE TYPE "public"."lead_lost_reason" AS ENUM('price', 'competitor', 'no_need', 'no_response', 'other');--> statement-breakpoint

CREATE TABLE "leads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "contact_person" varchar(255),
  "phone" varchar(64),
  "email" varchar(320),
  "address" text,
  "region" varchar(128),
  "status" "lead_status" NOT NULL DEFAULT 'new',
  "source" "lead_source" NOT NULL DEFAULT 'other',
  "estimated_value" numeric(14, 2) NOT NULL DEFAULT '0',
  "assigned_user_id" uuid,
  "notes" text,
  "next_action" text,
  "next_action_date" date,
  "score" integer NOT NULL DEFAULT 0,
  "lost_reason" "lead_lost_reason",
  "lost_comment" text,
  "converted_client_id" uuid,
  "converted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX "leads_tenant_status_idx"
  ON "leads" USING btree ("tenant_id", "status")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "leads_tenant_created_idx"
  ON "leads" USING btree ("tenant_id", "created_at")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "leads_tenant_assigned_idx"
  ON "leads" USING btree ("tenant_id", "assigned_user_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Ответственный менеджер: при удалении пользователя лид остаётся, ответственный сбрасывается.
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_user_id_fkey"
  FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Сконвертированный клиент: при удалении клиента лид остаётся, ссылка сбрасывается.
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_client_id_fkey"
  FOREIGN KEY ("converted_client_id") REFERENCES "clients"("id") ON DELETE SET NULL;
