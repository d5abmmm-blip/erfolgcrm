-- RLS для telegram_bot_configs.

ALTER TABLE telegram_bot_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_bot_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_telegram_bot_configs ON telegram_bot_configs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
