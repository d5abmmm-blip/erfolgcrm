CREATE TYPE "public"."asset_event_type" AS ENUM('created', 'status_change', 'owner_change', 'location_change', 'note');--> statement-breakpoint
CREATE TYPE "public"."asset_lifecycle_status" AS ENUM('in_service', 'in_repair', 'awaiting_parts', 'reserve', 'decommissioned');--> statement-breakpoint
CREATE TYPE "public"."med_device_risk_class" AS ENUM('1', '2a', '2b', '3');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."client_subtype" AS ENUM('commercial', 'budget');--> statement-breakpoint
CREATE TYPE "public"."client_type" AS ENUM('legal', 'individual');--> statement-breakpoint
CREATE TABLE "asset_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"user_id" uuid,
	"type" "asset_event_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_client_id" uuid NOT NULL,
	"model" varchar(200) NOT NULL,
	"manufacturer" varchar(200),
	"serial_number" varchar(100),
	"inventory_number" varchar(50),
	"location" text,
	"commissioned_at" date,
	"warranty_until" date,
	"lifecycle_status" "asset_lifecycle_status" DEFAULT 'in_service' NOT NULL,
	"risk_class" "med_device_risk_class",
	"requires_metrology" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" "client_type" NOT NULL,
	"subtype" "client_subtype",
	"display_name" varchar(200) NOT NULL,
	"inn" varchar(12),
	"kpp" varchar(9),
	"ogrn" varchar(15),
	"legal_address" text,
	"phone" varchar(50),
	"email" varchar(200),
	"treasury_account" varchar(20),
	"eks_account" varchar(20),
	"personal_account" varchar(20),
	"full_name_encrypted" "bytea",
	"phone_encrypted" "bytea",
	"address_encrypted" "bytea",
	"default_contact_id" uuid,
	"notes" text,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "clients_subtype_legal_only" CHECK (subtype IS NULL OR type = 'legal')
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"full_name_encrypted" "bytea" NOT NULL,
	"phone_encrypted" "bytea" NOT NULL,
	"email" varchar(200),
	"position" varchar(100),
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "asset_events_tenant_asset_idx" ON "asset_events" USING btree ("tenant_id","asset_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_tenant_owner_idx" ON "assets" USING btree ("tenant_id","owner_client_id");--> statement-breakpoint
CREATE INDEX "assets_tenant_serial_idx" ON "assets" USING btree ("tenant_id","serial_number");--> statement-breakpoint
CREATE INDEX "assets_tenant_status_idx" ON "assets" USING btree ("tenant_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "clients_tenant_inn_idx" ON "clients" USING btree ("tenant_id","inn");--> statement-breakpoint
CREATE INDEX "clients_tenant_displayname_idx" ON "clients" USING btree ("tenant_id","display_name");--> statement-breakpoint
CREATE INDEX "clients_tenant_status_idx" ON "clients" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "contacts_tenant_client_idx" ON "contacts" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_one_primary_per_client" ON "contacts" USING btree ("tenant_id","client_id") WHERE is_primary = true;--> statement-breakpoint
-- Foreign keys (drizzle не сгенерировал — fkUuid() не использует .references()).
-- Каскады:
--   contacts.client_id        → clients.id  ON DELETE CASCADE  (контакты удаляются вместе с клиентом)
--   asset_events.asset_id     → assets.id   ON DELETE CASCADE  (хронология умирает вместе с техникой)
--   assets.owner_client_id    → clients.id  ON DELETE RESTRICT (нельзя удалить клиента с техникой)
--   clients.default_contact_id → contacts.id ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
--      (циклическая ссылка — DEFERRED чтобы insert client+contact в одной транзакции работал)
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_client_id_fkey"
  FOREIGN KEY ("owner_client_id") REFERENCES "clients"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_default_contact_id_fkey"
  FOREIGN KEY ("default_contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;