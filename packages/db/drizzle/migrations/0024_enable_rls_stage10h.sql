-- RLS для client_users и client_sessions (Stage 10'.H).
-- Применяется setup-rls.ts. Каждый tenant видит только свои логины и сессии.

ALTER TABLE client_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_client_users ON client_users;
CREATE POLICY tenant_isolation_client_users ON client_users
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE client_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_client_sessions ON client_sessions;
CREATE POLICY tenant_isolation_client_sessions ON client_sessions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
