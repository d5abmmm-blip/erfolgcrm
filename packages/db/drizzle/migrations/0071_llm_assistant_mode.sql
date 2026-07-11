-- Режим работы ассистента: 'read_only' (только смотрит и советует) | 'full' (может
-- выполнять действия по запросу, с подтверждением). Выключение — отдельным флагом
-- llm_configs.enabled. Default 'full' — сохраняем текущее поведение.
-- RLS у llm_configs уже включён (0055) — отдельная RLS-миграция не нужна.

ALTER TABLE "llm_configs"
  ADD COLUMN IF NOT EXISTS "assistant_mode" varchar(16) NOT NULL DEFAULT 'full';
