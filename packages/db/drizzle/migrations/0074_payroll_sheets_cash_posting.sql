-- Проведение ручной ведомости в кассу (payroll_sheets → cash_transactions).
-- Директор может «Провести в кассу»: сумма ведомости за месяц становится расходом
-- (статья «Зарплата»), общие деньги уменьшаются. Здесь — ссылка на этот расход и
-- сумма/счёт/время проведения (для отображения «Проведено: X ₽» и перепроведения/отмены).
-- Колонки nullable: не проведённая ведомость — просто журнал.

ALTER TABLE "payroll_sheets"
  ADD COLUMN IF NOT EXISTS "cash_transaction_id" uuid,
  ADD COLUMN IF NOT EXISTS "posted_amount_kopecks" bigint,
  ADD COLUMN IF NOT EXISTS "posted_account_id" uuid,
  ADD COLUMN IF NOT EXISTS "posted_at" timestamp with time zone;
