-- Этап 8.B — Связь платежа со счётом.
--
-- Платёж может быть привязан к invoice (новый поток, 8.A) или просто к ticket (старый поток, 5).
-- invoice_id nullable — backward-compat: существующие платежи остаются «свободными» (привязаны к ticket).
--
-- Триггер: insert/delete payment с invoice_id !== NULL → пересчитывает invoices.paid_amount_kopecks
-- и переводит статус (см. payments/repository.ts: recomputeInvoiceFromPaid).

ALTER TABLE "payments" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint

ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE INDEX "payments_tenant_invoice_idx"
  ON "payments" USING btree ("tenant_id", "invoice_id")
  WHERE "invoice_id" IS NOT NULL;
