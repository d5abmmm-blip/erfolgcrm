-- Бэкфилл кассы: завести доход в кассе для уже существующих оплат по заявкам.
-- Идемпотентно (NOT EXISTS + UNIQUE по payment_id): повторный накат не задваивает.
-- Счёт выбираем по default_for_method, иначе первый активный счёт нужного типа.
-- Если у tenant нет подходящего счёта — payment пропускается (как no-op в cash-sync).

INSERT INTO cash_transactions (
  tenant_id, kind, account_id, category_id, amount_kopecks, occurred_on,
  comment, payment_id, invoice_id, ticket_id, user_id, source
)
SELECT
  p.tenant_id,
  'income',
  acc.id,
  cat.id,
  p.amount_kopecks,
  p.paid_at::date,
  'Оплата по заявке',
  p.id,
  p.invoice_id,
  p.ticket_id,
  p.user_id,
  'payment'
FROM payments p
JOIN LATERAL (
  SELECT a.id
    FROM cash_accounts a
   WHERE a.tenant_id = p.tenant_id
     AND a.deleted_at IS NULL
     AND a.is_archived = false
     AND (
       a.default_for_method = p.method
       OR a.kind::text = CASE p.method::text
                           WHEN 'cash' THEN 'cash'
                           WHEN 'card' THEN 'card'
                           WHEN 'bank_transfer' THEN 'bank'
                         END
     )
   ORDER BY (a.default_for_method = p.method) DESC, a.sort_order ASC
   LIMIT 1
) acc ON true
LEFT JOIN cash_categories cat
  ON cat.tenant_id = p.tenant_id
 AND cat.system_code = 'ticket_payment'
 AND cat.deleted_at IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM cash_transactions ct
   WHERE ct.tenant_id = p.tenant_id
     AND ct.payment_id = p.id
     AND ct.deleted_at IS NULL
);--> statement-breakpoint

-- Полный пересчёт остатков всех счетов (учитывает доходы/расходы/переводы).
UPDATE cash_accounts a
   SET balance_kopecks = a.opening_balance_kopecks + COALESCE((
         SELECT SUM(CASE
                  WHEN ct.kind = 'income'   AND ct.account_id = a.id THEN ct.amount_kopecks
                  WHEN ct.kind = 'expense'  AND ct.account_id = a.id THEN -ct.amount_kopecks
                  WHEN ct.kind = 'transfer' AND ct.account_id = a.id THEN -ct.amount_kopecks
                  WHEN ct.kind = 'transfer' AND ct.counter_account_id = a.id THEN ct.amount_kopecks
                  ELSE 0
                END)
           FROM cash_transactions ct
          WHERE ct.deleted_at IS NULL
            AND (ct.account_id = a.id OR ct.counter_account_id = a.id)
       ), 0)
 WHERE a.deleted_at IS NULL;
