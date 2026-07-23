-- Несколько инженеров на одну заявку.
--
-- Раньше исполнитель был ровно один — `tickets.assigned_engineer_id`. На тяжёлую технику
-- выезжают вдвоём-втроём, и второй инженер не видел заявку у себя в кабинете.
--
-- Устройство намеренно АСИММЕТРИЧНОЕ: ответственный остаётся там же, где был
-- (`tickets.assigned_engineer_id`), а здесь лежат только ПОМОЩНИКИ. Так график,
-- напоминания и отчёты загрузки продолжают работать без переделки (75 мест в коде),
-- а «кто ещё работает по заявке» становится списком.
--
-- Инвариант, который держит уникальный индекс: один человек не может быть
-- помощником дважды. Что помощник ≠ ответственный — следит код (repository).
CREATE TABLE IF NOT EXISTS "ticket_engineers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "ticket_engineers_uniq"
  ON "ticket_engineers" USING btree ("tenant_id", "ticket_id", "user_id");--> statement-breakpoint

-- «Какие заявки у этого инженера» — основной запрос кабинета инженера.
CREATE INDEX IF NOT EXISTS "ticket_engineers_tenant_user_idx"
  ON "ticket_engineers" USING btree ("tenant_id", "user_id");--> statement-breakpoint

-- «Кто работает по этой заявке» — карточка заявки и печать документов.
CREATE INDEX IF NOT EXISTS "ticket_engineers_tenant_ticket_idx"
  ON "ticket_engineers" USING btree ("tenant_id", "ticket_id");
