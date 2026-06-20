-- Продажи запчастей/оборудования клиентам (sales + sale_items).
-- Отдельно от ремонтных заявок. Сумма total_kopecks материализована (Σ позиций).
-- Оплата клиентом проводится в кассу как доход (см. sales/repository.ts).
--
-- RLS включается отдельно через 0052_enable_rls_sales.sql (setup-rls.ts).

DO $$ BEGIN
  CREATE TYPE "sale_status" AS ENUM('new', 'ordered', 'received', 'handed_over', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sales" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "sale_no" integer NOT NULL,
  "client_id" uuid NOT NULL,
  "status" "sale_status" DEFAULT 'new' NOT NULL,
  "supplier" varchar(200),
  "purchase_cost_kopecks" bigint DEFAULT 0 NOT NULL,
  "total_kopecks" bigint DEFAULT 0 NOT NULL,
  "comment" text,
  "paid_on" date,
  "account_id" uuid,
  "cash_transaction_id" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "sales_amounts_non_negative" CHECK (total_kopecks >= 0 AND purchase_cost_kopecks >= 0)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sale_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "sale_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "quantity" integer DEFAULT 1 NOT NULL,
  "unit_price_kopecks" bigint DEFAULT 0 NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sale_items_qty_pos" CHECK (quantity > 0),
  CONSTRAINT "sale_items_price_non_negative" CHECK (unit_price_kopecks >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "sales_tenant_no_uniq"
  ON "sales" USING btree ("tenant_id", "sale_no") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_status_idx"
  ON "sales" USING btree ("tenant_id", "status") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_client_idx"
  ON "sales" USING btree ("tenant_id", "client_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_created_idx"
  ON "sales" USING btree ("tenant_id", "created_at") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_items_tenant_sale_idx"
  ON "sale_items" USING btree ("tenant_id", "sale_id");
