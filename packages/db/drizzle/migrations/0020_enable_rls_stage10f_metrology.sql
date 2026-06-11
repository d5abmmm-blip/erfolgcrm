-- RLS для Stage 10'.F (metrology_si_details, metrology_calibrations).
-- Применяется setup-rls.ts. Каждый tenant видит только свои строки.

ALTER TABLE metrology_si_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrology_si_details FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_metrology_si_details ON metrology_si_details;
CREATE POLICY tenant_isolation_metrology_si_details ON metrology_si_details
  USING (tenant_id = current_tenant_id());

ALTER TABLE metrology_calibrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrology_calibrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_metrology_calibrations ON metrology_calibrations;
CREATE POLICY tenant_isolation_metrology_calibrations ON metrology_calibrations
  USING (tenant_id = current_tenant_id());
