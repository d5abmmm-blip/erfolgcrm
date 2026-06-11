-- RLS для бизнес-таблиц Этапа 3: tickets, ticket_events, work_orders, work_order_lines, tenant_counters.
-- Применяется тем же паттерном, что 0001/0004:
--   - ENABLE + FORCE ROW LEVEL SECURITY
--   - CREATE POLICY tenant_isolation_<table> USING (tenant_id = current_tenant_id())
--
-- Запускается setup-rls.ts (а не drizzle-kit migrate) — поэтому файл вне _journal.json.

-- tickets
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_tickets ON tickets
  USING (tenant_id = current_tenant_id());

-- ticket_events
ALTER TABLE ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ticket_events ON ticket_events
  USING (tenant_id = current_tenant_id());

-- work_orders
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_work_orders ON work_orders
  USING (tenant_id = current_tenant_id());

-- work_order_lines
ALTER TABLE work_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_work_order_lines ON work_order_lines
  USING (tenant_id = current_tenant_id());

-- tenant_counters
ALTER TABLE tenant_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_tenant_counters ON tenant_counters
  USING (tenant_id = current_tenant_id());
