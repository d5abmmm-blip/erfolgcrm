-- Раздел «Почта», Этап C — треды, чтение, спам + вложения входящих.
--
-- email_messages: заголовки треда (in_reply_to / references_list / thread_id),
--   отметка прочтения (read_at) и флаг спама (is_spam — reg.ru метит ***SPAM*** в теме).
--   in_reply_to / references_list — технические Message-ID, НЕ ПДн (не шифруем: нужны
--   для группировки треда и индексируются).
-- email_attachments: метаданные вложений входящих писем; сам файл лежит в S3/object-storage.
--
-- RLS для email_attachments включается отдельно через 0044_enable_rls_email_attachments.sql
-- (setup-rls.ts, вне drizzle journal).

ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "in_reply_to" varchar(512);--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "references_list" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "thread_id" varchar(512);--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "is_spam" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_messages_thread_idx" ON "email_messages" USING btree ("tenant_id", "thread_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "email_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "object_key" varchar(500) NOT NULL,
  "original_name" varchar(300) NOT NULL,
  "mime_type" varchar(100) NOT NULL,
  "size_bytes" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_attachments_tenant_msg_idx" ON "email_attachments" USING btree ("tenant_id", "message_id");
