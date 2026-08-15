-- Предсдаточный досмотр 2026-08-15, находка №22 — платежи нельзя удалять каскадом.
--
-- Миграция 0038 перевела финансовые FK на RESTRICT (invoices.ticket_id,
-- invoices.work_order_id, payments.invoice_id), но payments.ticket_id остался
-- из 0007 с ON DELETE CASCADE: жёсткое удаление заявки молча уносило платежи —
-- ровно то, от чего 0038 обещала защитить финансовые документы.
--
-- Приложение заявку физически не удаляет (только deleted_at, с блокировкой
-- при деньгах — deleteTicketCmd), поэтому RESTRICT ничего не ломает в работе,
-- но защищает историю оплат от случайной ручной команды в базе и от будущего
-- кода. Тестовые очистки удаляют payments → tickets в правильном порядке.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_ticket_id_fkey;--> statement-breakpoint

ALTER TABLE payments ADD CONSTRAINT payments_ticket_id_fkey
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE RESTRICT;
