-- Фикс аудита 2026-06-11 — недостающая колонка client_users.deletion_requested_at.
--
-- Колонка появилась в Drizzle-схеме (packages/db/src/schema/client-cabinet.ts)
-- вместе с DSAR-функционалом 152-ФЗ («удалить аккаунт» в клиентском кабинете),
-- но физический ALTER TABLE так и не был создан (в схеме остался TODO).
-- Из-за расхождения схема↔база падали все запросы кабинета, которые
-- упоминают колонку: создание client_user (RETURNING), exportMyData (DSAR),
-- markClientUserDeletionRequested.
--
-- Семантика: момент, когда пользователь кабинета нажал «удалить аккаунт».
-- NULL — запроса не было. Физическая зачистка данных — отдельным процессом
-- за пределами бухгалтерского срока хранения (5 лет).

ALTER TABLE client_users
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
