-- Stage 10'.G — Анти-спам лог напоминаний о поверках СИ.
--
-- metrology_reminder_log: одна запись на (tenant, user_id, calendar_date),
-- чтобы воркер metrology-reminder мог пропустить тех, кому уже сегодня отправил.
--
-- Логика:
--   • При успешной отправке email директору/диспетчеру воркер вставляет строку с sent_on=today.
--   • Перед отправкой проверяем существование строки с тем же sent_on — если есть, не шлём.
--   • UNIQUE(tenant_id, user_id, sent_on) защищает от гонок (вторая insert упадёт).
--
-- Чисто per-tenant таблица — RLS как у всех остальных tenant-таблиц
-- (см. 0022_enable_rls_stage10g.sql).

CREATE TABLE "metrology_reminder_log" (
  "id"          uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "user_id"     uuid NOT NULL,
  "sent_on"     date NOT NULL,
  "channel"     varchar(20) NOT NULL DEFAULT 'email',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "metrology_reminder_log_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "metrology_reminder_log_unique_per_day"
    UNIQUE ("tenant_id", "user_id", "sent_on", "channel")
);--> statement-breakpoint

CREATE INDEX "metrology_reminder_log_tenant_sent_idx"
  ON "metrology_reminder_log" ("tenant_id", "sent_on");
