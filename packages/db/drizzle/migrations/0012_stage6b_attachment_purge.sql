-- Этап 6.B-prod: фоновая чистка S3-объектов после soft-delete вложений.
--
-- Зачем: deleteCmd сейчас удаляет объект из S3 синхронно — а в проде это плохо,
-- потому что (1) blocks user request, (2) если S3 вернул ошибку — пользователь видит её,
-- (3) нет grace-периода для отмены случайного удаления.
--
-- Решение: после soft-delete (deleted_at) ставится delayed-job в BullMQ
-- 'storage-cleanup' с задержкой STORAGE_PURGE_DELAY_HOURS (24h по умолчанию).
-- Воркер:
--   1) проверяет что строка ещё помечена deleted_at NOT NULL и purged_at IS NULL;
--   2) удаляет объект из S3 (idempotent);
--   3) проставляет purged_at = now();
-- На случай рестарта BullMQ есть страховочный sweeper: ищет attachments где
-- deleted_at < now() - delay AND purged_at IS NULL — и догоняет.

ALTER TABLE "attachments" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint

-- Индекс для sweeper: быстро находить кандидатов на чистку.
CREATE INDEX "attachments_pending_purge_idx"
  ON "attachments" USING btree ("deleted_at")
  WHERE "deleted_at" IS NOT NULL AND "purged_at" IS NULL;
