-- Пользовательские события календаря — заметки менеджеров с датой
-- (встречи, поставки, напоминания). Показываются в разделе «Календарь»
-- рядом с системными событиями (выезды, ТО, окончания договоров).
--
-- RLS включается отдельно через 0039_enable_rls_calendar_events.sql
-- (запускается setup-rls.ts).

CREATE TABLE "calendar_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "title" varchar(200) NOT NULL,
  "event_date" date NOT NULL,
  "event_time" time,
  "notes" text,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX "calendar_events_tenant_date_idx"
  ON "calendar_events" USING btree ("tenant_id", "event_date")
  WHERE "deleted_at" IS NULL;
