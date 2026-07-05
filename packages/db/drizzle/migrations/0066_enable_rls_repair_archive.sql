-- RLS для repair_archive (архив ремонтов). Применяется setup-rls.ts.
-- Каждый tenant видит только свой архив.

ALTER TABLE repair_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_archive FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_repair_archive ON repair_archive;
CREATE POLICY tenant_isolation_repair_archive ON repair_archive
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
