-- RLS для выплат ЗП (payroll_payouts).
-- Запускается setup-rls.ts (вне drizzle journal). Изоляция по tenant_id через
-- current_tenant_id() (app.current_tenant_id, см. withTenantTx).

ALTER TABLE payroll_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_payroll_payouts ON payroll_payouts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
