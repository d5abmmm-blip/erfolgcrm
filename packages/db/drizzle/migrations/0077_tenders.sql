CREATE TYPE "public"."tender_status" AS ENUM ('won', 'in_progress', 'fulfilled', 'paid', 'cancelled');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "client_id" uuid NOT NULL,
  "contract_number" varchar(100) NOT NULL,
  "purchase_number" varchar(100),
  "amount_kopecks" bigint DEFAULT 0 NOT NULL,
  "contract_date" date NOT NULL,
  "due_date" date,
  "status" "tender_status" DEFAULT 'won' NOT NULL,
  "comment" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "tenders_amount_non_negative" CHECK (amount_kopecks >= 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tenders_tenant_date_idx"
  ON "tenders" USING btree ("tenant_id", "contract_date")
  WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tenders_tenant_status_idx"
  ON "tenders" USING btree ("tenant_id", "status")
  WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tenders_tenant_client_idx"
  ON "tenders" USING btree ("tenant_id", "client_id")
  WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tender_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "tender_id" uuid NOT NULL,
  "amount_kopecks" bigint NOT NULL,
  "paid_on" date NOT NULL,
  "note" varchar(300),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tender_payments_amount_positive" CHECK (amount_kopecks > 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tender_payments_tenant_tender_idx"
  ON "tender_payments" USING btree ("tenant_id", "tender_id");
