-- Касса / Движение денежных средств (ДДС).
-- Три таблицы поверх существующих invoices/payments:
--   cash_accounts     — денежные счета с материализованным остатком (balance_kopecks);
--   cash_categories   — статьи доходов/расходов (системные + пользовательские);
--   cash_transactions — операции доход/расход/перевод; payment_id связывает авто-доход
--                       с оплатой по заявке (UNIQUE среди живых = защита от задвоения).
-- Суммы — копейки (bigint). Soft-delete через deleted_at.
--
-- RLS включается отдельно через 0047_enable_rls_cash.sql (setup-rls.ts).

-- enum-типы (идемпотентно: повторный накат на вторую БД не падает)
DO $$ BEGIN
  CREATE TYPE "cash_account_kind" AS ENUM('cash', 'bank', 'card');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "cash_direction" AS ENUM('income', 'expense');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "cash_tx_kind" AS ENUM('income', 'expense', 'transfer');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cash_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(120) NOT NULL,
  "kind" "cash_account_kind" NOT NULL,
  "opening_balance_kopecks" bigint DEFAULT 0 NOT NULL,
  "balance_kopecks" bigint DEFAULT 0 NOT NULL,
  "default_for_method" "payment_method",
  "is_archived" boolean DEFAULT false NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cash_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(120) NOT NULL,
  "direction" "cash_direction" NOT NULL,
  "is_system" boolean DEFAULT false NOT NULL,
  "system_code" varchar(40),
  "is_archived" boolean DEFAULT false NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cash_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "kind" "cash_tx_kind" NOT NULL,
  "account_id" uuid NOT NULL,
  "counter_account_id" uuid,
  "category_id" uuid,
  "amount_kopecks" bigint NOT NULL,
  "occurred_on" date NOT NULL,
  "comment" text,
  "counterparty" varchar(200),
  "client_id" uuid,
  "user_id" uuid,
  "payment_id" uuid,
  "invoice_id" uuid,
  "ticket_id" uuid,
  "source" varchar(20) DEFAULT 'manual' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "cash_tx_amount_pos" CHECK (amount_kopecks > 0),
  CONSTRAINT "cash_tx_transfer_shape" CHECK (
    (kind = 'transfer' AND counter_account_id IS NOT NULL AND counter_account_id <> account_id AND category_id IS NULL)
    OR (kind <> 'transfer' AND counter_account_id IS NULL)
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "cash_accounts_default_method_uniq"
  ON "cash_accounts" USING btree ("tenant_id", "default_for_method")
  WHERE default_for_method IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_accounts_tenant_idx"
  ON "cash_accounts" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "cash_categories_system_code_uniq"
  ON "cash_categories" USING btree ("tenant_id", "system_code")
  WHERE system_code IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_categories_tenant_direction_idx"
  ON "cash_categories" USING btree ("tenant_id", "direction") WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "cash_tx_payment_uniq"
  ON "cash_transactions" USING btree ("tenant_id", "payment_id")
  WHERE payment_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_tx_tenant_occurred_idx"
  ON "cash_transactions" USING btree ("tenant_id", "occurred_on" DESC) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_tx_tenant_account_idx"
  ON "cash_transactions" USING btree ("tenant_id", "account_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_tx_tenant_counter_account_idx"
  ON "cash_transactions" USING btree ("tenant_id", "counter_account_id")
  WHERE counter_account_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_tx_tenant_category_idx"
  ON "cash_transactions" USING btree ("tenant_id", "category_id") WHERE deleted_at IS NULL;
