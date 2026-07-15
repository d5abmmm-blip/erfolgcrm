ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_tasks ON tasks
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
