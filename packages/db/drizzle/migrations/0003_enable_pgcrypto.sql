-- Включаем расширение pgcrypto.
-- Используется для шифрования ПДн (ФИО/телефон/адрес физлиц-клиентов и контактных лиц юрлиц).
-- Функции: pgp_sym_encrypt(text, key) и pgp_sym_decrypt(blob, key).
-- Ключ — приложение передаёт через crypto.ts (`getTenantEncryptionKey`).
--
-- В Yandex Managed PostgreSQL расширение предустановлено, IF NOT EXISTS — no-op.
-- В локальном Docker (postgres:16) — superuser dev-роль erfolg может установить расширение.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
