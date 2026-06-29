-- RLS для каталога моделей техники (asset_models).
-- Запускается setup-rls.ts (вне drizzle journal). Изоляция по tenant_id через
-- current_tenant_id() (app.current_tenant_id, см. withTenantTx).

ALTER TABLE asset_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_models FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_asset_models ON asset_models
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
