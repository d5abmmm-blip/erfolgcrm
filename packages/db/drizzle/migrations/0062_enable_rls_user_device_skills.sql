-- RLS для навыков инженеров (user_device_skills).
-- Запускается setup-rls.ts (вне drizzle journal). Изоляция по tenant_id.

ALTER TABLE user_device_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_device_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_user_device_skills ON user_device_skills
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
