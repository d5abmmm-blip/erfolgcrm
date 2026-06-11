-- Трейд-ин (перенос из v1 project_2).
--
-- Приём б/у техники в зачёт: received → assessed → in_stock → sold/scrapped.
-- sold выставляется только через complete-команду (атомарный перенос владельца
-- привязанного asset'а + событие owner_change). Деньги — bigint копейки.
--
-- RLS включается отдельно через 0034_enable_rls_trade_in.sql (запускается setup-rls.ts).

CREATE TYPE "public"."trade_in_condition" AS ENUM('excellent', 'good', 'fair', 'poor');--> statement-breakpoint
CREATE TYPE "public"."trade_in_status" AS ENUM('received', 'assessed', 'in_stock', 'sold', 'scrapped');--> statement-breakpoint

CREATE TABLE "trade_in_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "manufacturer" varchar(200),
  "model" varchar(200),
  "serial_number" varchar(100),
  "year" integer,
  "condition" "trade_in_condition" NOT NULL DEFAULT 'good',
  "status" "trade_in_status" NOT NULL DEFAULT 'received',
  "client_id" uuid,
  "buyer_client_id" uuid,
  "asset_id" uuid,
  "purchase_price_kopecks" bigint NOT NULL DEFAULT 0,
  "assessed_price_kopecks" bigint NOT NULL DEFAULT 0,
  "sale_price_kopecks" bigint,
  "notes" text,
  "received_at" date NOT NULL,
  "sold_at" date,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX "trade_in_tenant_status_idx"
  ON "trade_in_items" USING btree ("tenant_id", "status")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "trade_in_tenant_received_idx"
  ON "trade_in_items" USING btree ("tenant_id", "received_at")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

ALTER TABLE "trade_in_items" ADD CONSTRAINT "trade_in_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "trade_in_items" ADD CONSTRAINT "trade_in_buyer_client_id_fkey"
  FOREIGN KEY ("buyer_client_id") REFERENCES "clients"("id") ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "trade_in_items" ADD CONSTRAINT "trade_in_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL;
