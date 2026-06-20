-- Продажи: закупочная цена по позициям (за сколько купили каждую).
-- «Закупка всего» (sales.purchase_cost_kopecks) теперь считается как сумма по строкам.

ALTER TABLE "sale_items"
  ADD COLUMN IF NOT EXISTS "unit_cost_kopecks" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_cost_non_negative" CHECK (unit_cost_kopecks >= 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;
