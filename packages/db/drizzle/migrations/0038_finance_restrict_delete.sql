-- Фикс аудита 2026-06-11 — финансовые документы нельзя удалить каскадом.
--
-- В коде схемы (schema/invoices.ts) с самого начала задуман RESTRICT
-- («нельзя удалить заявку со счетами»), но миграции 0015/0016 поставили
-- противоположное: ON DELETE CASCADE. Итог: hard delete заявки молча
-- уносил счета и платежи — финансовые документы исчезали без следа.
--
-- Продакшен-код заявки физически НЕ удаляет (только soft delete через
-- deleted_at), поэтому RESTRICT ничего не ломает в работе приложения,
-- но защищает от случайной ручной команды в базе и от будущей кнопки
-- «удалить». Тестовые очистки удаляют payments → invoices → tickets
-- в правильном порядке.

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_ticket_id_fkey;--> statement-breakpoint

ALTER TABLE invoices ADD CONSTRAINT invoices_ticket_id_fkey
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_work_order_id_fkey;--> statement-breakpoint

ALTER TABLE invoices ADD CONSTRAINT invoices_work_order_id_fkey
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_invoice_id_fkey;--> statement-breakpoint

ALTER TABLE payments ADD CONSTRAINT payments_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT;
