-- Этап B (приём входящих по IMAP): состояние инкрементальной выборки на ящике.
-- imap_last_uid — последний обработанный UID письма (фетчим только UID > этого).
-- imap_last_fetch_at — время последней синхронизации (для UI/диагностики).

ALTER TABLE "email_configs" ADD COLUMN IF NOT EXISTS "imap_last_uid" bigint;--> statement-breakpoint
ALTER TABLE "email_configs" ADD COLUMN IF NOT EXISTS "imap_last_fetch_at" timestamp with time zone;
