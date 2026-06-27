-- RLS для конфигурации AI-ассистента (llm_configs).
-- Запускается setup-rls.ts (вне drizzle journal). Изоляция по tenant_id через
-- current_tenant_id() (app.current_tenant_id, см. withTenantTx).

ALTER TABLE llm_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_llm_configs ON llm_configs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
