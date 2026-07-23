ALTER TABLE ticket_engineers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_engineers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ticket_engineers ON ticket_engineers
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
