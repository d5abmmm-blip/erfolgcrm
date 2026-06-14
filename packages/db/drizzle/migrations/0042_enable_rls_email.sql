-- RLS для email_configs и email_messages. Запускается setup-rls.ts (вне drizzle journal).
-- Изоляция по tenant_id через current_tenant_id() (app.current_tenant_id, см. withTenantTx).

ALTER TABLE email_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_email_configs ON email_configs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_email_messages ON email_messages
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
