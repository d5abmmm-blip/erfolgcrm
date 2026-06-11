-- КП (коммерческие предложения) с версиями по заявке (перенос из v1 project_2).
--
-- Несколько версий КП на заявку (v1 → скидка → v2 → approve), история сохраняется.
-- Инварианты: одна approved-версия на заявку (approve демотирует прочие),
-- approved не удаляется, version назначает сервер (max+1).
-- Суммы — bigint копейки (конвенция v2).
--
-- RLS включается отдельно через 0033_enable_rls_kp_versions.sql (запускается setup-rls.ts).

CREATE TYPE "public"."kp_status" AS ENUM('draft', 'sent', 'approved', 'rejected', 'revision');--> statement-breakpoint

CREATE TABLE "ticket_kp_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" "kp_status" NOT NULL DEFAULT 'draft',
  "works_amount_kopecks" bigint NOT NULL DEFAULT 0,
  "parts_amount_kopecks" bigint NOT NULL DEFAULT 0,
  "description" text NOT NULL,
  "sent_at" timestamp with time zone,
  "responded_at" timestamp with time zone,
  "rejection_reason" text,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX "kp_versions_ticket_version_uniq"
  ON "ticket_kp_versions" USING btree ("tenant_id", "ticket_id", "version")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "kp_versions_tenant_ticket_idx"
  ON "ticket_kp_versions" USING btree ("tenant_id", "ticket_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

ALTER TABLE "ticket_kp_versions" ADD CONSTRAINT "kp_versions_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "ticket_kp_versions" ADD CONSTRAINT "kp_versions_created_by_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
