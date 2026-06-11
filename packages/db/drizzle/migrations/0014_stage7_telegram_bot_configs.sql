-- Этап 7-B: конфигурация Telegram-бота per-tenant.
--
-- Один tenant — один бот (PK = tenant_id). bot_token и webhook_secret хранятся зашифрованными.
-- RLS включается отдельно через 0014_enable_rls_stage7_telegram.sql.

CREATE TABLE "telegram_bot_configs" (
  "tenant_id" uuid PRIMARY KEY NOT NULL,
  "bot_token_encrypted" bytea NOT NULL,
  "webhook_secret_encrypted" bytea NOT NULL,
  "bot_username" varchar(64),
  "enabled" boolean NOT NULL DEFAULT true,
  "default_dispatcher_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "telegram_bot_configs" ADD CONSTRAINT "telegram_bot_configs_dispatcher_fkey"
  FOREIGN KEY ("default_dispatcher_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
