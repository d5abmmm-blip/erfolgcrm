-- RLS для engineer_payout_rules. Применяется setup-rls.ts.
-- Каждый tenant видит только свою singleton-запись.

ALTER TABLE engineer_payout_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE engineer_payout_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_engineer_payout_rules ON engineer_payout_rules;
CREATE POLICY tenant_isolation_engineer_payout_rules ON engineer_payout_rules
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
