-- Stage 10'.J — Чек-листы приёма/выдачи техники.
--
-- Бизнес-цель: фиксировать состояние техники "до" и "после" с фото каждого пункта,
-- чтобы исключать споры с клиентом ("при приёме царапины не было!").
--
-- Один тикет может иметь несколько чек-листов (intake — при приёме, handover — при выдаче).
-- Каждый чек-лист — список пунктов (label + status [ok|issue|na] + comment + photo_attachment).
--
-- Подпись клиента — пока ФИО строкой (полноценная подпись в кабинете клиента — позже).

CREATE TYPE checklist_kind AS ENUM ('intake', 'handover');

CREATE TABLE "intake_checklists" (
  "id"                       uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"                uuid NOT NULL,
  "ticket_id"                uuid NOT NULL,
  "kind"                     checklist_kind NOT NULL,
  "completed_at"             timestamptz NOT NULL DEFAULT now(),
  "completed_by_user_id"     uuid,
  "client_signature_name"    varchar(200),
  "notes"                    text,
  "deleted_at"               timestamptz,
  CONSTRAINT "intake_checklists_ticket_fk"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE,
  CONSTRAINT "intake_checklists_user_fk"
    FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id")
);--> statement-breakpoint

CREATE TABLE "intake_checklist_items" (
  "id"                       uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"                uuid NOT NULL,
  "checklist_id"             uuid NOT NULL,
  "order_idx"                int NOT NULL,
  "label"                    varchar(300) NOT NULL,
  "status"                   varchar(20) NOT NULL,
  "comment"                  text,
  "photo_attachment_id"      uuid,
  CONSTRAINT "intake_checklist_items_checklist_fk"
    FOREIGN KEY ("checklist_id") REFERENCES "intake_checklists"("id") ON DELETE CASCADE,
  CONSTRAINT "intake_checklist_items_attachment_fk"
    FOREIGN KEY ("photo_attachment_id") REFERENCES "attachments"("id")
);--> statement-breakpoint

CREATE INDEX "intake_checklists_tenant_ticket_idx"
  ON "intake_checklists" ("tenant_id", "ticket_id");--> statement-breakpoint

CREATE INDEX "intake_checklist_items_tenant_checklist_idx"
  ON "intake_checklist_items" ("tenant_id", "checklist_id");
