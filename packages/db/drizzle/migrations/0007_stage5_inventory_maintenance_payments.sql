-- Этап 5: Склад с FEFO + Журнал ТО + Финансы Lite.
-- Создаются 6 таблиц: inventory_items, inventory_batches, inventory_movements,
-- maintenance_schedules, maintenance_log, payments.
-- RLS включается отдельно через 0009_enable_rls_stage5.sql (вне drizzle journal).

CREATE TYPE "public"."inventory_movement_kind" AS ENUM('inbound', 'outbound', 'adjustment', 'writeoff');--> statement-breakpoint
CREATE TYPE "public"."inventory_reference_type" AS ENUM('work_order_line', 'manual');--> statement-breakpoint
CREATE TYPE "public"."maintenance_kind" AS ENUM('planned', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'card', 'bank_transfer');--> statement-breakpoint

-- inventory_items: справочник товаров (запчасти, расходники).
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(300) NOT NULL,
	"sku" varchar(100),
	"manufacturer" varchar(200),
	"unit" varchar(20) DEFAULT 'шт' NOT NULL,
	"min_stock" numeric(12,3) DEFAULT '0' NOT NULL,
	"category" varchar(100),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

-- inventory_batches: партии прихода. Остаток уменьшается при outbound/writeoff.
CREATE TABLE "inventory_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_code" varchar(100),
	"quantity_initial" numeric(12,3) NOT NULL,
	"quantity_remaining" numeric(12,3) NOT NULL,
	"unit_cost_kopecks" bigint DEFAULT 0 NOT NULL,
	"supplier" varchar(300),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_batches_qty_nonneg" CHECK ("quantity_remaining" >= 0),
	CONSTRAINT "inventory_batches_qty_le_initial" CHECK ("quantity_remaining" <= "quantity_initial"),
	CONSTRAINT "inventory_batches_qty_initial_pos" CHECK ("quantity_initial" > 0)
);
--> statement-breakpoint

-- inventory_movements: append-only журнал движений.
-- Quantity знаковая: positive — приход, negative — расход.
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity" numeric(12,3) NOT NULL,
	"kind" "inventory_movement_kind" NOT NULL,
	"reference_type" "inventory_reference_type" DEFAULT 'manual' NOT NULL,
	"reference_id" uuid,
	"user_id" uuid,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_qty_nonzero" CHECK ("quantity" <> 0)
);
--> statement-breakpoint

-- maintenance_schedules: планы ТО (interval_days, next_due_at).
CREATE TABLE "maintenance_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "maintenance_kind" DEFAULT 'planned' NOT NULL,
	"interval_days" integer NOT NULL,
	"last_done_at" timestamp with time zone,
	"next_due_at" timestamp with time zone NOT NULL,
	"responsible_user_id" uuid,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "maintenance_schedules_interval_pos" CHECK ("interval_days" > 0)
);
--> statement-breakpoint

-- maintenance_log: факты выполнения ТО. Append-only.
CREATE TABLE "maintenance_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"schedule_id" uuid,
	"ticket_id" uuid,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"performed_by_user_id" uuid,
	"summary" varchar(1000) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- payments: платежи по заявке. work_orders.paid_amount_kopecks материализован.
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"amount_kopecks" bigint NOT NULL,
	"method" "payment_method" DEFAULT 'cash' NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"comment" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_pos" CHECK ("amount_kopecks" > 0)
);
--> statement-breakpoint

-- Индексы.
CREATE UNIQUE INDEX "inventory_items_tenant_sku_uniq" ON "inventory_items" USING btree ("tenant_id","sku") WHERE "sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inventory_items_tenant_name_idx" ON "inventory_items" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "inventory_items_tenant_category_idx" ON "inventory_items" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE INDEX "inventory_batches_tenant_item_idx" ON "inventory_batches" USING btree ("tenant_id","item_id");--> statement-breakpoint
-- Партиальный FEFO-индекс — мотор issueToWorkOrder. NULLS LAST: партии без срока уходят последними.
CREATE INDEX "inventory_batches_fefo_idx" ON "inventory_batches" USING btree ("tenant_id","item_id","expires_at" ASC NULLS LAST,"received_at") WHERE "quantity_remaining" > 0;--> statement-breakpoint
CREATE INDEX "inventory_movements_tenant_item_idx" ON "inventory_movements" USING btree ("tenant_id","item_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_tenant_ref_idx" ON "inventory_movements" USING btree ("tenant_id","reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "maintenance_schedules_tenant_asset_idx" ON "maintenance_schedules" USING btree ("tenant_id","asset_id");--> statement-breakpoint
CREATE INDEX "maintenance_schedules_tenant_due_idx" ON "maintenance_schedules" USING btree ("tenant_id","next_due_at") WHERE "is_active" = true;--> statement-breakpoint
CREATE INDEX "maintenance_log_tenant_asset_idx" ON "maintenance_log" USING btree ("tenant_id","asset_id","performed_at");--> statement-breakpoint
CREATE INDEX "maintenance_log_tenant_schedule_idx" ON "maintenance_log" USING btree ("tenant_id","schedule_id");--> statement-breakpoint
CREATE INDEX "payments_tenant_ticket_idx" ON "payments" USING btree ("tenant_id","ticket_id","paid_at");--> statement-breakpoint

-- Foreign keys.
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "inventory_batches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_responsible_user_id_fkey"
  FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD CONSTRAINT "maintenance_log_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD CONSTRAINT "maintenance_log_schedule_id_fkey"
  FOREIGN KEY ("schedule_id") REFERENCES "maintenance_schedules"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD CONSTRAINT "maintenance_log_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD CONSTRAINT "maintenance_log_performed_by_user_id_fkey"
  FOREIGN KEY ("performed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
