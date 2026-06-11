-- Этап 8 — Финансы. Счета (invoices).
--
-- Бизнес-модель:
--   • На один наряд (work_order) — один счёт. Уникальный индекс по (tenant_id, work_order_id)
--     среди живых записей форсит 1:1.
--   • Сквозной номер per tenant per year через tenant_counters.kind='invoice' (формат "INV-2026-000017").
--   • status: draft → issued → (partially_paid | paid) → archived; либо cancelled из любого.
--     overdue — отдельный статус, выставляется ночным cron'ом (8.E) на основе due_date + paid_amount.
--   • Денежные суммы (total/vat) — snapshot на момент перехода в issued. Это важно: если потом
--     поменяются строки в work_order — счёт остаётся «таким, каким его выставили клиенту».
--   • paid_amount_kopecks — материализован (пересчитывается в payments/service.ts при insert/delete
--     платежа с invoice_id !== null, см. 8.B).
--
-- 152-ФЗ: number, totals и due_date — не PII; notes может содержать ПДн → попадает под redact в логах.
--
-- RLS включается отдельно через 0015_enable_rls_stage8_invoices.sql (запускается setup-rls.ts).

CREATE TYPE "public"."invoice_status" AS ENUM (
  'draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled'
);--> statement-breakpoint

CREATE TABLE "invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "invoice_number" varchar(30) NOT NULL,
  "client_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "work_order_id" uuid NOT NULL,
  "status" "invoice_status" NOT NULL DEFAULT 'draft',
  "vat_rate" "vat_rate" NOT NULL DEFAULT '5',
  -- Snapshot сумм на момент перехода в issued (для draft = текущие totals work_order).
  "total_amount_kopecks" bigint NOT NULL DEFAULT 0,
  "vat_amount_kopecks" bigint NOT NULL DEFAULT 0,
  -- Материализованная сумма платежей по этому счёту.
  "paid_amount_kopecks" bigint NOT NULL DEFAULT 0,
  "issue_date" date NOT NULL DEFAULT CURRENT_DATE,
  "due_date" date NOT NULL,
  "notes" text,
  "issued_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  -- 8.E (ночной воркер-напоминалка)
  "last_reminder_sent_at" timestamp with time zone,
  "reminder_count" integer NOT NULL DEFAULT 0,
  -- 8.F (зарезервировано под обмен с 1С)
  "onec_synced_at" timestamp with time zone,
  "onec_external_id" varchar(64),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "invoices_amounts_non_negative" CHECK (
    "total_amount_kopecks" >= 0 AND
    "vat_amount_kopecks" >= 0 AND
    "paid_amount_kopecks" >= 0
  ),
  CONSTRAINT "invoices_paid_not_exceeds_total" CHECK (
    "paid_amount_kopecks" <= "total_amount_kopecks"
  ),
  CONSTRAINT "invoices_vat_not_exceeds_total" CHECK (
    "vat_amount_kopecks" <= "total_amount_kopecks"
  ),
  CONSTRAINT "invoices_due_after_issue" CHECK (
    "due_date" >= "issue_date"
  )
);--> statement-breakpoint

-- Уникальный номер счёта per tenant среди живых.
CREATE UNIQUE INDEX "invoices_tenant_number_uniq"
  ON "invoices" USING btree ("tenant_id", "invoice_number")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- 1:1 с work_order среди живых (нельзя выставить два счёта на один наряд).
CREATE UNIQUE INDEX "invoices_tenant_work_order_uniq"
  ON "invoices" USING btree ("tenant_id", "work_order_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "invoices_tenant_client_idx"
  ON "invoices" USING btree ("tenant_id", "client_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "invoices_tenant_ticket_idx"
  ON "invoices" USING btree ("tenant_id", "ticket_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "invoices_tenant_status_idx"
  ON "invoices" USING btree ("tenant_id", "status")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Для воркера-напоминалки (8.E): быстрый поиск просроченных к проверке.
CREATE INDEX "invoices_overdue_check_idx"
  ON "invoices" USING btree ("tenant_id", "due_date")
  WHERE "deleted_at" IS NULL AND "status" IN ('issued', 'partially_paid', 'overdue');--> statement-breakpoint

-- Для выгрузки в 1С (8.F): какие счета ещё не выгружались.
CREATE INDEX "invoices_pending_onec_export_idx"
  ON "invoices" USING btree ("tenant_id", "updated_at")
  WHERE "deleted_at" IS NULL AND "onec_synced_at" IS NULL AND "status" <> 'draft';--> statement-breakpoint

-- client_id защищаем (нельзя случайно удалить клиента, на котором висят счета).
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ticket/work_order — CASCADE: на практике hard-delete tickets/work_orders не делается
-- (только soft через deleted_at), но если тестовая утилита/миграция данных требует hard delete —
-- счета должны уйти вместе. Для production пути — soft delete без удаления invoice.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_work_order_id_fkey"
  FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE CASCADE;
