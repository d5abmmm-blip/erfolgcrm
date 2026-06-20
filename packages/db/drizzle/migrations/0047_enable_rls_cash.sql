-- RLS для кассы (cash_accounts, cash_categories, cash_transactions).
-- Запускается setup-rls.ts (вне drizzle journal). Изоляция по tenant_id через
-- current_tenant_id() (app.current_tenant_id, см. withTenantTx).

ALTER TABLE cash_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_cash_accounts ON cash_accounts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE cash_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_cash_categories ON cash_categories
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE cash_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_cash_transactions ON cash_transactions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
