-- Stage 11 — График загрузки инженеров.
--
-- Бизнес-цель: диспетчер видит на календаре, какой инженер чем занят
-- в течение недели (Drag & Drop), а инженер видит свою загрузку.
--
-- Поля добавляются в tickets:
--   scheduled_start_at — когда заявка запланирована к началу работ.
--   scheduled_end_at   — когда запланирован конец (NULL если только начало).
--   estimated_minutes  — оценка трудозатрат в минутах (15..720).
--
-- CHECK гарантирует консистентность интервала (end >= start, если оба заданы).
-- Партиальные индексы экономят место/быстрее ищут (только запланированные).
-- audit_action enum дополняется значением 'schedule_change' (используется в
-- apps/api/src/lib/audit.ts при ставке/снятии расписания).

-- ─── 1. Расширяем audit_action enum ────────────────────────────────────────
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'schedule_change';--> statement-breakpoint

-- ─── 2. Колонки расписания на tickets ──────────────────────────────────────
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS scheduled_start_at timestamptz;--> statement-breakpoint

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS scheduled_end_at timestamptz;--> statement-breakpoint

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS estimated_minutes integer;--> statement-breakpoint

-- ─── 3. CHECK consistency: end >= start если оба заданы ─────────────────────
ALTER TABLE tickets
  DROP CONSTRAINT IF EXISTS tickets_schedule_consistency;--> statement-breakpoint

ALTER TABLE tickets
  ADD CONSTRAINT tickets_schedule_consistency
  CHECK (scheduled_end_at IS NULL OR scheduled_start_at IS NULL OR scheduled_end_at >= scheduled_start_at);--> statement-breakpoint

-- ─── 4. Индексы для быстрых запросов «по инженеру и неделе» ────────────────
-- Партиальный (WHERE start IS NOT NULL) — экономит место, ускоряет фильтр.
CREATE INDEX IF NOT EXISTS tickets_engineer_schedule_idx
  ON tickets (tenant_id, assigned_engineer_id, scheduled_start_at)
  WHERE scheduled_start_at IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS tickets_schedule_window_idx
  ON tickets (tenant_id, scheduled_start_at)
  WHERE scheduled_start_at IS NOT NULL;
