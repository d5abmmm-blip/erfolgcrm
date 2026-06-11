CREATE TYPE "public"."ticket_status" AS ENUM('received', 'diagnostics', 'estimate', 'approval', 'in_progress', 'act_pending', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ticket_source" AS ENUM('call', 'telegram', 'email', 'manual', 'web_form');--> statement-breakpoint
CREATE TYPE "public"."intake_method" AS ENUM('onsite_visit', 'brought_in', 'pickup');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."repair_type" AS ENUM('paid', 'warranty', 'service_contract');--> statement-breakpoint
CREATE TYPE "public"."ticket_event_type" AS ENUM('created', 'status_change', 'assignment_change', 'priority_change', 'sla_change', 'note', 'document_printed');--> statement-breakpoint
CREATE TYPE "public"."work_order_line_type" AS ENUM('work', 'part', 'expense');--> statement-breakpoint
CREATE TYPE "public"."vat_rate" AS ENUM('0', '5', '10', '20', 'without_vat');--> statement-breakpoint
CREATE TABLE "tenant_counters" (
	"tenant_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"year" integer NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_counters_pkey" PRIMARY KEY("tenant_id","kind","year")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_number" varchar(30) NOT NULL,
	"barcode" varchar(64) NOT NULL,
	"client_id" uuid NOT NULL,
	"asset_id" uuid,
	"contact_id" uuid,
	"source" "ticket_source" DEFAULT 'call' NOT NULL,
	"intake_method" "intake_method" DEFAULT 'brought_in' NOT NULL,
	"repair_type" "repair_type" DEFAULT 'paid' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'normal' NOT NULL,
	"status" "ticket_status" DEFAULT 'received' NOT NULL,
	"symptom" text,
	"notes" text,
	"assigned_dispatcher_id" uuid,
	"assigned_engineer_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sla_target_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tickets_barcode_unique" UNIQUE("barcode"),
	CONSTRAINT "tickets_closed_consistency" CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
	CONSTRAINT "tickets_cancelled_consistency" CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"user_id" uuid,
	"type" "ticket_event_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"order_number" varchar(30) NOT NULL,
	"engineer_id" uuid,
	"diagnosis" text,
	"repair_description" text,
	"recommendation" text,
	"vat_rate" "vat_rate" DEFAULT '5' NOT NULL,
	"works_amount_kopecks" bigint DEFAULT 0 NOT NULL,
	"parts_amount_kopecks" bigint DEFAULT 0 NOT NULL,
	"expenses_amount_kopecks" bigint DEFAULT 0 NOT NULL,
	"total_amount_kopecks" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"line_type" "work_order_line_type" NOT NULL,
	"name" varchar(500) NOT NULL,
	"unit" varchar(20) DEFAULT 'шт' NOT NULL,
	"quantity" numeric(10,3) DEFAULT '1' NOT NULL,
	"unit_price_kopecks" bigint DEFAULT 0 NOT NULL,
	"amount_kopecks" bigint DEFAULT 0 NOT NULL,
	"engineer_id" uuid,
	"comment" text,
	"order_idx" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_tenant_number_uniq" ON "tickets" USING btree ("tenant_id","ticket_number");--> statement-breakpoint
CREATE INDEX "tickets_tenant_status_idx" ON "tickets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "tickets_tenant_client_idx" ON "tickets" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "tickets_tenant_asset_idx" ON "tickets" USING btree ("tenant_id","asset_id");--> statement-breakpoint
CREATE INDEX "tickets_tenant_engineer_idx" ON "tickets" USING btree ("tenant_id","assigned_engineer_id");--> statement-breakpoint
CREATE INDEX "tickets_tenant_received_idx" ON "tickets" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "ticket_events_tenant_ticket_idx" ON "ticket_events" USING btree ("tenant_id","ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_ticket_uniq" ON "work_orders" USING btree ("tenant_id","ticket_id");--> statement-breakpoint
CREATE INDEX "work_orders_tenant_engineer_idx" ON "work_orders" USING btree ("tenant_id","engineer_id");--> statement-breakpoint
CREATE INDEX "work_order_lines_tenant_order_idx" ON "work_order_lines" USING btree ("tenant_id","work_order_id","order_idx");--> statement-breakpoint
-- Foreign keys (drizzle не сгенерировал — fkUuid() не использует .references()).
-- Каскады:
--   tickets.client_id              → clients.id        ON DELETE RESTRICT
--   tickets.asset_id               → assets.id         ON DELETE SET NULL
--   tickets.contact_id             → contacts.id       ON DELETE SET NULL
--   tickets.assigned_dispatcher_id → users.id          ON DELETE SET NULL
--   tickets.assigned_engineer_id   → users.id          ON DELETE SET NULL
--   ticket_events.ticket_id        → tickets.id        ON DELETE CASCADE
--   ticket_events.user_id          → users.id          ON DELETE SET NULL
--   work_orders.ticket_id          → tickets.id        ON DELETE CASCADE
--   work_orders.engineer_id        → users.id          ON DELETE SET NULL
--   work_order_lines.work_order_id → work_orders.id    ON DELETE CASCADE
--   work_order_lines.engineer_id   → users.id          ON DELETE SET NULL
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_dispatcher_fkey"
  FOREIGN KEY ("assigned_dispatcher_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_engineer_fkey"
  FOREIGN KEY ("assigned_engineer_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_engineer_fkey"
  FOREIGN KEY ("engineer_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "work_order_lines" ADD CONSTRAINT "work_order_lines_work_order_id_fkey"
  FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_order_lines" ADD CONSTRAINT "work_order_lines_engineer_fkey"
  FOREIGN KEY ("engineer_id") REFERENCES "users"("id") ON DELETE SET NULL;
