-- Раздел «Почта» — полноценный почтовый клиент.
--
-- Черновик и запланированное письмо — это просто неотправленные исходящие, поэтому
-- расширяем email_messages, а не строим отдельную таблицу:
--   status += 'draft' | 'scheduled' (пересоздаём CHECK);
--   scheduled_at — время отложенной отправки;
--   cc_addr_encrypted / bcc_addr_encrypted — копия/скрытая копия (ПДн, шифруются как to/from).
-- Корзина — через уже существующий deleted_at (мягкое удаление, из общих timestamps).
-- email_configs.signature — общая подпись компании (не ПДн: уходит в каждом письме).
--
-- Новых таблиц нет → RLS уже включён на email_messages/email_configs, setup-rls не нужен.

ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "cc_addr_encrypted" bytea;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "bcc_addr_encrypted" bytea;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "email_messages" DROP CONSTRAINT IF EXISTS "email_messages_status_chk";--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_status_chk" CHECK (status IN ('sent','skipped','failed','received','draft','scheduled'));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_messages_scheduled_idx" ON "email_messages" USING btree ("tenant_id", "scheduled_at") WHERE "scheduled_at" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "email_configs" ADD COLUMN IF NOT EXISTS "signature" text;
