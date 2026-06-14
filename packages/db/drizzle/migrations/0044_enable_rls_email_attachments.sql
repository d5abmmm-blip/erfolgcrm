-- RLS для email_attachments (Этап C). Запускается setup-rls.ts (вне drizzle journal).
-- Изоляция по tenant_id через current_tenant_id() (app.current_tenant_id, см. withTenantTx).

ALTER TABLE email_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_email_attachments ON email_attachments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
