-- RLS для бизнес-таблиц Этапа 5: inventory_items, inventory_batches, inventory_movements,
-- maintenance_schedules, maintenance_log, payments.
-- Применяется тем же паттерном, что 0001/0004/0006:
--   - ENABLE + FORCE ROW LEVEL SECURITY
--   - CREATE POLICY tenant_isolation_<table> USING (tenant_id = current_tenant_id())
--
-- Запускается setup-rls.ts (а не drizzle-kit migrate) — поэтому файл вне _journal.json.

-- inventory_items
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_inventory_items ON inventory_items
  USING (tenant_id = current_tenant_id());

-- inventory_batches
ALTER TABLE inventory_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_inventory_batches ON inventory_batches
  USING (tenant_id = current_tenant_id());

-- inventory_movements
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_inventory_movements ON inventory_movements
  USING (tenant_id = current_tenant_id());

-- maintenance_schedules
ALTER TABLE maintenance_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_maintenance_schedules ON maintenance_schedules
  USING (tenant_id = current_tenant_id());

-- maintenance_log
ALTER TABLE maintenance_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_maintenance_log ON maintenance_log
  USING (tenant_id = current_tenant_id());

-- payments
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_payments ON payments
  USING (tenant_id = current_tenant_id());
