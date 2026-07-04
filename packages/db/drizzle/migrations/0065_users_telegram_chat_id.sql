-- Привязка сотрудника к Telegram-чату tenant-бота: нуджи инженерам с inline-кнопками.
-- chat_id уникален в рамках tenant'а (один чат — один сотрудник).
-- RLS у users уже включён — отдельная RLS-миграция не нужна.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegram_chat_id" bigint;

CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_telegram_chat_unique"
  ON "users" ("tenant_id", "telegram_chat_id") WHERE "telegram_chat_id" IS NOT NULL;
