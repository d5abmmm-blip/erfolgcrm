ALTER TABLE tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_tenders ON tenders
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE tender_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_tender_payments ON tender_payments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
