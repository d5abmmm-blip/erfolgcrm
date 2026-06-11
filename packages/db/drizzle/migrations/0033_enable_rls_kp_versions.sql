-- RLS для ticket_kp_versions. Запускается setup-rls.ts (вне drizzle journal).

ALTER TABLE ticket_kp_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_kp_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ticket_kp_versions ON ticket_kp_versions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
