-- Удаление домена «Метрология» (2026-06-11, личный режим — функционал не нужен).
--
-- Сносит таблицы Stage 10'.F/G (metrology_si_details, metrology_calibrations,
-- metrology_reminder_log), enum metrology_calibration_result и флаг
-- assets.requires_metrology. Таблицы на момент удаления пустые; структурный
-- дамп сохранён в archive/metrology/db-dump.sql, код — в archive/metrology/.
--
-- Исторические миграции 0020/0022 не редактируются (replay на свежей БД создаст
-- таблицы, а эта миграция их снесёт); их RLS-файлы skip'аются setup-rls.ts
-- автоматически (trigger-таблицы больше не существуют).

DROP TABLE IF EXISTS "metrology_reminder_log" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "metrology_calibrations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "metrology_si_details" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."metrology_calibration_result";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN IF EXISTS "requires_metrology";
