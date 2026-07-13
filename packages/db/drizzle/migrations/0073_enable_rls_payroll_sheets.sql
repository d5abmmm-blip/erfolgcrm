-- RLS для ручной ведомости (payroll_sheets).
-- Запускается setup-rls.ts (вне drizzle journal). Изоляция по tenant_id через
-- current_tenant_id() (app.current_tenant_id, см. withTenantTx).

ALTER TABLE payroll_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_sheets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_payroll_sheets ON payroll_sheets
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
