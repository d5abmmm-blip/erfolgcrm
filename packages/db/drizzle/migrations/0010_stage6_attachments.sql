-- Этап 6: единый реестр вложений (фото, документы, скан-копии).
-- Файлы хранятся в Yandex Object Storage (bucket per-tenant), эта таблица — только метаданные.
--
-- Жизненный цикл строки:
--   1. createUploadUrl → INSERT с uploaded_at = NULL (presigned PUT URL выдан клиенту).
--   2. confirmUpload    → UPDATE uploaded_at = now() после успешного PUT в S3.
--   3. delete           → soft delete (deleted_at = now()), реальный объект чистится фоновым job'ом.
--
-- RLS включается отдельно через 0010_enable_rls_stage6.sql.

CREATE TYPE "public"."attachment_kind" AS ENUM(
  'ticket_photo',
  'asset_photo',
  'inventory_receipt',
  'damage_photo',
  'completion_photo',
  'contract_signed',
  'document'
);--> statement-breakpoint

CREATE TYPE "public"."attachment_reference_type" AS ENUM(
  'ticket',
  'asset',
  'inventory_batch',
  'work_order_line',
  'contract'
);--> statement-breakpoint

CREATE TABLE "attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "kind" "attachment_kind" NOT NULL,
  "reference_type" "attachment_reference_type" NOT NULL,
  "reference_id" uuid NOT NULL,
  "object_key" varchar(500) NOT NULL,
  "original_name" varchar(300) NOT NULL,
  "mime_type" varchar(100) NOT NULL,
  "size_bytes" bigint NOT NULL,
  "uploaded_by_user_id" uuid,
  "uploaded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "attachments_size_nonneg" CHECK ("size_bytes" >= 0),
  CONSTRAINT "attachments_object_key_uniq" UNIQUE ("object_key")
);--> statement-breakpoint

CREATE INDEX "attachments_tenant_ref_idx" ON "attachments"
  USING btree ("tenant_id","reference_type","reference_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "attachments_tenant_kind_idx" ON "attachments"
  USING btree ("tenant_id","kind","created_at")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "attachments_pending_idx" ON "attachments"
  USING btree ("tenant_id","created_at")
  WHERE "uploaded_at" IS NULL AND "deleted_at" IS NULL;--> statement-breakpoint

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_user_id_fkey"
  FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
