-- Уборка: удаляем шифрованные колонки-предшественники, которые никто не читает.
--
-- ЗАЧЕМ. Миграции 0078/0079 добавили открытые колонки, скрипт `decrypt-pii` перенёс
-- в них данные (на бою — 937 значений, сверка сошлась построчно), и с 21 июля код
-- читает только открытые. Старые bytea-колонки с тех пор лежат мёртвым грузом: они
-- намеренно НЕ удалялись сразу, чтобы откат стоил ноль. Откат больше не нужен —
-- новый код отработал на бою две недели. Дальше держать их вредно: они выглядят как
-- «данные под защитой», хотя ключ от них лежит в .env на том же сервере, и любая
-- будущая правда о ПДн («что у нас зашифровано?») читалась бы неверно.
--
-- ⚠️ ЧТО ЭТА МИГРАЦИЯ НЕ ТРОГАЕТ — И ПОЧЕМУ ИМЕННО ТАК.
--
-- 1. `clients.phone_encrypted` ОСТАЁТСЯ. Проверка перед удалением нашла на бою
--    3 строки, где зашифрованный телефон есть, а открытого нет вовсе (физлица из
--    импорта 07.07). Для них это НЕ дубликат, а единственный экземпляр данных:
--    удаление колонки стёрло бы 3 телефона навсегда. Что это — настоящие номера или
--    мусор, вычищенный из открытых колонок в июле, — без расшифровки не узнать,
--    а решение по ним принимает владелец. Колонка ждёт этого решения.
--    Проверка, которая это ловит (0 = можно удалять):
--      SELECT count(*) FROM clients WHERE phone_encrypted IS NOT NULL
--                                     AND individual_phone IS NULL;
--
-- 2. Секреты доступа НЕ трогаются вообще: `email_configs.smtp/imap_password_encrypted`,
--    `telegram_bot_configs.*`, `llm_configs.api_key_encrypted`, `users.totp_secret_enc`.
--    Это не ПДн и не наследие, а рабочее шифрование живых секретов — пароль почтового
--    ящика читается из него при каждой отправке письма. PII_ENCRYPTION_KEY остаётся
--    нужен именно ради них.
--
-- ОТКАТ. После этой миграции откат к шифрованию уже НЕ бесплатный: колонки исчезают
-- вместе с содержимым. Восстановление — только из дампа, снятого перед выкатом.
-- Данные при этом не теряются: открытые копии всех этих значений уже в базе и рабочие.

-- ПДн клиентов (0078). phone_encrypted сознательно оставлен — см. пункт 1 выше.
ALTER TABLE "clients" DROP COLUMN IF EXISTS "full_name_encrypted";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN IF EXISTS "address_encrypted";--> statement-breakpoint

-- ПДн контактных лиц (0078). Здесь сирот нет: перенос прошёл полностью.
ALTER TABLE "contacts" DROP COLUMN IF EXISTS "full_name_encrypted";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN IF EXISTS "phone_encrypted";--> statement-breakpoint

-- Переписка с клиентами (0079). Тела и адреса писем — открытые колонки заполнены.
ALTER TABLE "email_messages" DROP COLUMN IF EXISTS "from_addr_encrypted";--> statement-breakpoint
ALTER TABLE "email_messages" DROP COLUMN IF EXISTS "to_addr_encrypted";--> statement-breakpoint
ALTER TABLE "email_messages" DROP COLUMN IF EXISTS "cc_addr_encrypted";--> statement-breakpoint
ALTER TABLE "email_messages" DROP COLUMN IF EXISTS "bcc_addr_encrypted";--> statement-breakpoint
ALTER TABLE "email_messages" DROP COLUMN IF EXISTS "subject_encrypted";--> statement-breakpoint
ALTER TABLE "email_messages" DROP COLUMN IF EXISTS "body_text_encrypted";--> statement-breakpoint
ALTER TABLE "email_messages" DROP COLUMN IF EXISTS "body_html_encrypted";
