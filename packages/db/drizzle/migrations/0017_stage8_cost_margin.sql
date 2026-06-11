-- Этап 8.C — Себестоимость и маржа.
--
-- Поля:
--   • users.hourly_cost_rate_kopecks — внутренняя ставка инженера за час (для расчёта себестоимости работ).
--     Это НЕ ставка для клиента (та хранится в work_order_line.unit_price_kopecks как «цена работы»).
--     Для не-engineer ролей значение игнорируется.
--   • work_order_lines.cost_per_unit_kopecks — snapshot себестоимости единицы на момент создания строки.
--     Источник:
--       - 'work':    users.hourly_cost_rate_kopecks инженера (на 1 час)
--       - 'part' c inventory_item_id: средневзвешенная цена закупки активных партий
--       - 'part' без item_id или 'expense': 0 (свободные строки) или unit_price (для expense — внутренний расход)
--   • work_orders.cost_amount_kopecks — материализованная сумма cost_per_unit × quantity по строкам.
--   • work_orders.margin_amount_kopecks — материализованное (total - cost). Может быть отрицательным
--     (если работали в убыток) — отдельный CHECK сигнализирует об этом.
--
-- Snapshot означает: если потом изменится hourly_cost_rate инженера или цена закупки запчасти,
-- ранее созданные строки остаются с историческим cost. Это бухгалтерская модель.

ALTER TABLE "users"
  ADD COLUMN "hourly_cost_rate_kopecks" bigint NOT NULL DEFAULT 0;--> statement-breakpoint

ALTER TABLE "work_order_lines"
  ADD COLUMN "cost_per_unit_kopecks" bigint NOT NULL DEFAULT 0;--> statement-breakpoint

ALTER TABLE "work_order_lines"
  ADD CONSTRAINT "work_order_lines_cost_non_negative" CHECK (cost_per_unit_kopecks >= 0);--> statement-breakpoint

ALTER TABLE "work_orders"
  ADD COLUMN "cost_amount_kopecks" bigint NOT NULL DEFAULT 0;--> statement-breakpoint

ALTER TABLE "work_orders"
  ADD COLUMN "margin_amount_kopecks" bigint NOT NULL DEFAULT 0;--> statement-breakpoint

ALTER TABLE "work_orders"
  ADD CONSTRAINT "work_orders_cost_non_negative" CHECK (cost_amount_kopecks >= 0);
