-- Напоминания о своих событиях календаря (push накануне в 09:00).
--
--   remind_at   — момент, когда нужно отправить push (вычисляется при
--                 создании/правке события в поясе организации). NULL —
--                 напоминание не запрошено или время уже в прошлом.
--   reminded_at — когда push фактически отправлен (повторно не шлём).
--
-- Частичный индекс — ровно под запрос воркера «что пора отправить».

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS remind_at timestamptz;--> statement-breakpoint

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS reminded_at timestamptz;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS calendar_events_remind_due_idx
  ON calendar_events (remind_at)
  WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND deleted_at IS NULL;
