-- ПДн клиентов, контактов и лидов переезжают из шифрованных колонок в открытые.
--
-- ЗАЧЕМ. Шифрование ПДн через pgp_sym_encrypt осталось от времён SaaS, когда база
-- считалась общей для многих арендаторов. Сейчас это один сервер одной компании, и ключ
-- (PII_ENCRYPTION_KEY) лежит в .env на ТОМ ЖЕ сервере, что и база — то есть от кражи
-- сервера шифрование не защищает (об этом честно написано в packages/db/src/crypto.ts).
-- Зато оно создаёт риск, которого нет ни у чего другого в системе: потеря ключа делает
-- ФИО и телефоны физлиц нечитаемыми НАВСЕГДА при живой и целой базе.
-- Защиту «украли файл бэкапа» возвращаем на уровне самого файла бэкапа, а не колонок.
--
-- ЧТО ЭТА МИГРАЦИЯ ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ.
-- Делает: добавляет пустые открытые колонки рядом с шифрованными.
-- НЕ делает: не переносит данные и НЕ удаляет шифрованные колонки.
--   Перенос — отдельный скрипт `pnpm --filter @erfolg/db decrypt-pii` (ему нужен ключ,
--   а в .sql ключ не передать). Удаление старых колонок — отдельной миграцией потом,
--   когда перенос проверен. Пока они лежат нетронутыми, откат стоит ноль:
--   старый код читает их и работает как раньше.
--
-- ⚠️ ПОРЯДОК ВЫКАТА НА БОЙ — ОН ЗДЕСЬ ВАЖЕН.
--   1. бэкап базы;
--   2. git reset --hard origin/main;
--   3. build api web            (работающие контейнеры пока не трогаются);
--   4. МИГРАЦИЯ разовым контейнером — появляются пустые колонки;
--   5. `pnpm --filter @erfolg/db decrypt-pii` разовым контейнером — колонки наполняются.
--      Старый код в это время ещё работает и ничего не замечает: он читает шифрованные;
--   6. up -d api web            — новый код встаёт на УЖЕ заполненные колонки.
-- Поменять местами 5 и 6 НЕЛЬЗЯ: новый код читает открытые колонки, и в промежутке
-- у всех физлиц ФИО, телефон и адрес показались бы ПУСТЫМИ. Данные при этом целы,
-- но менеджер увидит пустую картотеку и решит, что всё пропало.
-- Скрипту из шага 5 нужен PII_ENCRYPTION_KEY — берётся из окружения api-контейнера.
--
-- ПОЧЕМУ ИМЕНА С ПРЕФИКСОМ individual_. У clients уже заняты `phone` и `legal_address` —
-- это РАБОЧИЕ реквизиты организации, у физлица они NULL. Смешивать их с личным телефоном
-- и домашним адресом человека нельзя: разный смысл и разная чувствительность.
-- Имена совпадают с полями DTO (individualFullName / individualPhone / individualAddress).
-- У contacts коллизии нет — там открытых phone/full_name не было вовсе.

ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "individual_full_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "individual_phone" varchar(50);--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "individual_address" text;--> statement-breakpoint

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "full_name" varchar(200);--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "phone" varchar(50);--> statement-breakpoint

-- ОБЯЗАТЕЛЬНО, иначе новый контакт вообще не вставить: у contacts шифрованные колонки
-- объявлены NOT NULL, а новый код их больше не заполняет (значения по умолчанию у них нет).
-- Само удаление колонок — миграцией-уборкой; здесь только снимаем требование заполнять.
ALTER TABLE "contacts" ALTER COLUMN "full_name_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "phone_encrypted" DROP NOT NULL;--> statement-breakpoint

-- Поиск физлица по телефону раньше был sequential scan с расшифровкой КАЖДОЙ строки
-- (clients/repository.ts, findIndividualClientIdByPhone). Теперь сравниваем последние
-- 10 цифр открытого номера — тот же смысл («+7 928…» и «8928…» это один номер),
-- но по индексу. Частичный: физлица с телефоном — меньшинство строк.
CREATE INDEX IF NOT EXISTS "clients_individual_phone_tail_idx"
  ON "clients" (
    "tenant_id",
    RIGHT(regexp_replace("individual_phone", '\D', '', 'g'), 10)
  )
  WHERE "type" = 'individual' AND "individual_phone" IS NOT NULL;--> statement-breakpoint

-- Поиск клиента по ФИО. До этой миграции найти физлицо по полному ФИО было НЕЛЬЗЯ:
-- searchClients искал только по display_name (инициалы «Иванов И.И.») и ИНН.
CREATE INDEX IF NOT EXISTS "clients_individual_full_name_idx"
  ON "clients" ("tenant_id", "individual_full_name")
  WHERE "individual_full_name" IS NOT NULL;
