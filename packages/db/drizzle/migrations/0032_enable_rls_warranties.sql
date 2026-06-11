-- RLS для warranties. Запускается setup-rls.ts (вне drizzle journal).

ALTER TABLE warranties ENABLE ROW LEVEL SECURITY;
ALTER TABLE warranties FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_warranties ON warranties
  USING (tenant_id = current_tenant_id());
