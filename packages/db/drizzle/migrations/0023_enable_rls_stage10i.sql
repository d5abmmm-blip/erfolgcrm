-- RLS для engineer_attestations (Stage 10'.I).
-- Применяется setup-rls.ts. Каждый tenant видит только свои допуски.

ALTER TABLE engineer_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE engineer_attestations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_engineer_attestations ON engineer_attestations;
CREATE POLICY tenant_isolation_engineer_attestations ON engineer_attestations
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
