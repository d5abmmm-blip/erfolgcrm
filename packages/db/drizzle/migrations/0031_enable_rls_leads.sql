-- RLS для leads. Запускается setup-rls.ts (вне drizzle journal).
-- Изоляция по tenant_id через current_tenant_id() (app.current_tenant_id, см. withTenantTx).

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_leads ON leads
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
