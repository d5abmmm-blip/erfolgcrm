-- RLS для onec_exchange_log + onec_configs. Запускается setup-rls.ts.

ALTER TABLE onec_exchange_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE onec_exchange_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_onec_exchange_log ON onec_exchange_log
  USING (tenant_id = current_tenant_id());

ALTER TABLE onec_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE onec_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_onec_configs ON onec_configs
  USING (tenant_id = current_tenant_id());
