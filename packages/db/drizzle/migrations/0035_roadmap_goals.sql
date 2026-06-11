-- Дорожная карта — внутренние цели по кварталам (перенос из v1 project_2).
--
-- RLS включается отдельно через 0035_enable_rls_roadmap.sql (запускается setup-rls.ts).

CREATE TYPE "public"."roadmap_quarter" AS ENUM('Q1', 'Q2', 'Q3', 'Q4');--> statement-breakpoint
CREATE TYPE "public"."roadmap_category" AS ENUM('revenue', 'clients', 'processes', 'team', 'product');--> statement-breakpoint
CREATE TYPE "public"."roadmap_priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint

CREATE TABLE "roadmap_goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "quarter" "roadmap_quarter" NOT NULL,
  "year" integer NOT NULL,
  "title" varchar(255) NOT NULL,
  "description" text,
  "target_value" integer,
  "current_value" integer,
  "unit" varchar(32),
  "category" "roadmap_category" NOT NULL,
  "priority" "roadmap_priority" NOT NULL DEFAULT 'medium',
  "is_done" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX "roadmap_tenant_period_idx"
  ON "roadmap_goals" USING btree ("tenant_id", "year", "quarter")
  WHERE "deleted_at" IS NULL;
