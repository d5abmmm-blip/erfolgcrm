-- Stage 10'.C — 2FA TOTP для роли Director (compliance, 152-ФЗ).
--
-- Расширяем users:
--   • totp_secret_enc           — TOTP secret, зашифрованный pgp_sym_encrypt тем же
--                                 ключом (PII_ENCRYPTION_KEY), что и остальные ПДн.
--                                 NULL ⇒ 2FA не включена.
--   • totp_enabled_at           — момент активации. NULL ⇒ 2FA не включена.
--   • recovery_codes_hashes     — массив argon2-хешей одноразовых recovery-кодов
--                                 (10 штук). Используются вместо TOTP при потере телефона.
--                                 jsonb массив строк-хешей. NULL ⇒ нет кодов.
--
-- RLS уже распространяется на всю таблицу users (см. 0001_enable_rls.sql),
-- эти колонки автоматически защищены.

ALTER TABLE "users"
  ADD COLUMN "totp_secret_enc" bytea;--> statement-breakpoint

ALTER TABLE "users"
  ADD COLUMN "totp_enabled_at" timestamptz;--> statement-breakpoint

ALTER TABLE "users"
  ADD COLUMN "recovery_codes_hashes" jsonb;--> statement-breakpoint
