-- RLS для занятости инженеров (user_availability).
-- Запускается setup-rls.ts (вне drizzle journal). Изоляция по tenant_id.

ALTER TABLE user_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_availability FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_user_availability ON user_availability
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
