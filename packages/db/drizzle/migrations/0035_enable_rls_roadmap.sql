-- RLS для roadmap_goals. Запускается setup-rls.ts (вне drizzle journal).

ALTER TABLE roadmap_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE roadmap_goals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_roadmap_goals ON roadmap_goals
  USING (tenant_id = current_tenant_id());
