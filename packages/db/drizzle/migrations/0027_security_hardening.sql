-- Security hardening: Block A.
--
-- Этот файл выполняется drizzle-kit migrate (через _journal.json) и применяет:
--   1. UNIQUE для дедупликации платежей из 1С (payments.external_payment_id).
--   2. WITH CHECK для всех существующих RLS-политик (защита на INSERT/UPDATE).
--      Без WITH CHECK можно вставить запись с tenant_id чужого tenant'а — USING смотрит
--      только на чтение, а CHECK проверяет что строка после INSERT/UPDATE удовлетворяет
--      политике.
--   3. Индексы для частых запросов (sessions, consent_records, client_sessions).
--   4. CHECK на intake_checklist_items.status (whitelist значений).
--   5. DROP audit_logs_global — после pivot single-company control plane не нужен.
--
-- Идемпотентность: используем DROP POLICY/INDEX IF EXISTS + CREATE.
-- RLS-политики из enable_rls-файлов пересоздаём с обоими USING и WITH CHECK.

-- ─────────────── 1. Дедупликация платежей из 1С ───────────────
-- Колонка typed как text чтобы соответствовать схеме (schema/payments.ts: text('external_payment_id')).
-- Хотя ТЗ говорит varchar(128), PostgreSQL хранит их одинаково; text избегает рассинхрона
-- с Drizzle-схемой при последующих generate.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS external_payment_id text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS payments_external_dedup_idx
  ON payments (tenant_id, invoice_id, external_payment_id)
  WHERE external_payment_id IS NOT NULL;--> statement-breakpoint

-- ─────────────── 2. Перевыпуск RLS-политик с WITH CHECK ───────────────
-- Этап 1 (миграция 0001_enable_rls.sql): users, sessions, audit_logs, consent_records, subscriptions

DROP POLICY IF EXISTS tenant_isolation_users ON users;--> statement-breakpoint
CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_sessions ON sessions;--> statement-breakpoint
CREATE POLICY tenant_isolation_sessions ON sessions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_audit_logs ON audit_logs;--> statement-breakpoint
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_consent_records ON consent_records;--> statement-breakpoint
CREATE POLICY tenant_isolation_consent_records ON consent_records
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_subscriptions ON subscriptions;--> statement-breakpoint
CREATE POLICY tenant_isolation_subscriptions ON subscriptions
  USING (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL);--> statement-breakpoint

-- Этап 2 (0004_enable_rls_stage2.sql): clients, contacts, assets, asset_events

DROP POLICY IF EXISTS tenant_isolation_clients ON clients;--> statement-breakpoint
CREATE POLICY tenant_isolation_clients ON clients
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_contacts ON contacts;--> statement-breakpoint
CREATE POLICY tenant_isolation_contacts ON contacts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_assets ON assets;--> statement-breakpoint
CREATE POLICY tenant_isolation_assets ON assets
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_asset_events ON asset_events;--> statement-breakpoint
CREATE POLICY tenant_isolation_asset_events ON asset_events
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Этап 3 (0006_enable_rls_stage3.sql): tickets, ticket_events, work_orders, work_order_lines, tenant_counters

DROP POLICY IF EXISTS tenant_isolation_tickets ON tickets;--> statement-breakpoint
CREATE POLICY tenant_isolation_tickets ON tickets
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_ticket_events ON ticket_events;--> statement-breakpoint
CREATE POLICY tenant_isolation_ticket_events ON ticket_events
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_work_orders ON work_orders;--> statement-breakpoint
CREATE POLICY tenant_isolation_work_orders ON work_orders
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_work_order_lines ON work_order_lines;--> statement-breakpoint
CREATE POLICY tenant_isolation_work_order_lines ON work_order_lines
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_tenant_counters ON tenant_counters;--> statement-breakpoint
CREATE POLICY tenant_isolation_tenant_counters ON tenant_counters
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Этап 5 (0009_enable_rls_stage5.sql): inventory_items, inventory_batches, inventory_movements,
-- maintenance_schedules, maintenance_log, payments

DROP POLICY IF EXISTS tenant_isolation_inventory_items ON inventory_items;--> statement-breakpoint
CREATE POLICY tenant_isolation_inventory_items ON inventory_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_inventory_batches ON inventory_batches;--> statement-breakpoint
CREATE POLICY tenant_isolation_inventory_batches ON inventory_batches
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_inventory_movements ON inventory_movements;--> statement-breakpoint
CREATE POLICY tenant_isolation_inventory_movements ON inventory_movements
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_maintenance_schedules ON maintenance_schedules;--> statement-breakpoint
CREATE POLICY tenant_isolation_maintenance_schedules ON maintenance_schedules
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_maintenance_log ON maintenance_log;--> statement-breakpoint
CREATE POLICY tenant_isolation_maintenance_log ON maintenance_log
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_payments ON payments;--> statement-breakpoint
CREATE POLICY tenant_isolation_payments ON payments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Этап 6 (0010_enable_rls_stage6.sql + 0011_enable_rls_stage6_contracts.sql): attachments, contracts

DROP POLICY IF EXISTS tenant_isolation_attachments ON attachments;--> statement-breakpoint
CREATE POLICY tenant_isolation_attachments ON attachments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_contracts ON contracts;--> statement-breakpoint
CREATE POLICY tenant_isolation_contracts ON contracts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Этап 7 (0013_enable_rls_stage7_push.sql + 0014_enable_rls_stage7_telegram.sql)

DROP POLICY IF EXISTS tenant_isolation_push_subscriptions ON push_subscriptions;--> statement-breakpoint
CREATE POLICY tenant_isolation_push_subscriptions ON push_subscriptions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_telegram_bot_configs ON telegram_bot_configs;--> statement-breakpoint
CREATE POLICY tenant_isolation_telegram_bot_configs ON telegram_bot_configs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Этап 8 (0015_enable_rls_stage8_invoices.sql + 0018_enable_rls_stage8_onec.sql)

DROP POLICY IF EXISTS tenant_isolation_invoices ON invoices;--> statement-breakpoint
CREATE POLICY tenant_isolation_invoices ON invoices
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_onec_exchange_log ON onec_exchange_log;--> statement-breakpoint
CREATE POLICY tenant_isolation_onec_exchange_log ON onec_exchange_log
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_onec_configs ON onec_configs;--> statement-breakpoint
CREATE POLICY tenant_isolation_onec_configs ON onec_configs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Этап 9 (0019_enable_rls_stage9_payroll.sql)

DROP POLICY IF EXISTS tenant_isolation_engineer_payout_rules ON engineer_payout_rules;--> statement-breakpoint
CREATE POLICY tenant_isolation_engineer_payout_rules ON engineer_payout_rules
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Stage 10'.F (0020_enable_rls_stage10f_metrology.sql)

DROP POLICY IF EXISTS tenant_isolation_metrology_si_details ON metrology_si_details;--> statement-breakpoint
CREATE POLICY tenant_isolation_metrology_si_details ON metrology_si_details
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_metrology_calibrations ON metrology_calibrations;--> statement-breakpoint
CREATE POLICY tenant_isolation_metrology_calibrations ON metrology_calibrations
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Stage 10'.G (0022_enable_rls_stage10g.sql)

DROP POLICY IF EXISTS tenant_isolation_metrology_reminder_log ON metrology_reminder_log;--> statement-breakpoint
CREATE POLICY tenant_isolation_metrology_reminder_log ON metrology_reminder_log
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Stage 10'.I (0023_enable_rls_stage10i.sql)

DROP POLICY IF EXISTS tenant_isolation_engineer_attestations ON engineer_attestations;--> statement-breakpoint
CREATE POLICY tenant_isolation_engineer_attestations ON engineer_attestations
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Stage 10'.H (0024_enable_rls_stage10h.sql)

DROP POLICY IF EXISTS tenant_isolation_client_users ON client_users;--> statement-breakpoint
CREATE POLICY tenant_isolation_client_users ON client_users
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_client_sessions ON client_sessions;--> statement-breakpoint
CREATE POLICY tenant_isolation_client_sessions ON client_sessions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Stage 10'.J (0026_enable_rls_stage10j.sql)

DROP POLICY IF EXISTS tenant_isolation_intake_checklists ON intake_checklists;--> statement-breakpoint
CREATE POLICY tenant_isolation_intake_checklists ON intake_checklists
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation_intake_checklist_items ON intake_checklist_items;--> statement-breakpoint
CREATE POLICY tenant_isolation_intake_checklist_items ON intake_checklist_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- ─────────────── 3. Индексы для частых запросов ───────────────

CREATE INDEX IF NOT EXISTS sessions_tenant_user_idx
  ON sessions (tenant_id, user_id);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sessions_active_idx
  ON sessions (expires_at)
  WHERE revoked_at IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS consent_records_subject_idx
  ON consent_records (tenant_id, subject_type, subject_id, consent_type);--> statement-breakpoint

-- client_sessions: дропаем старый non-unique token-индекс и заводим UNIQUE по session_token.
-- Поле уже UNIQUE на уровне колонки (см. schema/client-cabinet.ts), но дополнительный
-- именованный UNIQUE index упрощает поиск и явно фиксирует инвариант.
DROP INDEX IF EXISTS client_sessions_token_idx;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS client_sessions_token_uniq
  ON client_sessions (session_token);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS client_sessions_active_idx
  ON client_sessions (expires_at)
  WHERE revoked_at IS NULL;--> statement-breakpoint

-- ─────────────── 4. CHECK для intake_checklist_items.status ───────────────

ALTER TABLE intake_checklist_items
  DROP CONSTRAINT IF EXISTS intake_status_chk;--> statement-breakpoint

ALTER TABLE intake_checklist_items
  ADD CONSTRAINT intake_status_chk CHECK (status IN ('ok','issue','na'));--> statement-breakpoint

-- ─────────────── 5. Удаляем audit_logs_global ───────────────
-- После pivot single-company control plane не существует. Таблица не использовалась
-- ни в одном модуле приложения (grep'нули apps/api/src — нет ни одной ссылки).
-- Если в будущем понадобится глобальный аудит — заведём заново.

DROP TABLE IF EXISTS audit_logs_global;
