-- Этап 5: расширение существующих work_orders / work_order_lines.
--   - work_orders.paid_amount_kopecks: материализованная сумма платежей по заявке.
--     Пересчитывается в payments/service.ts при insert/delete payment в той же транзакции.
--   - work_order_lines.inventory_item_id: ссылка на товар склада (только для line_type='part').
--     SET NULL при удалении item — строка наряда сохраняет историю с name.

ALTER TABLE "work_orders" ADD COLUMN "paid_amount_kopecks" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_order_lines" ADD COLUMN "inventory_item_id" uuid;--> statement-breakpoint
ALTER TABLE "work_order_lines" ADD CONSTRAINT "work_order_lines_inventory_item_id_fkey"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE SET NULL;
