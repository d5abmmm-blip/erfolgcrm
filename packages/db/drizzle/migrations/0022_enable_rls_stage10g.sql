-- RLS для metrology_reminder_log (Stage 10'.G).
-- Применяется setup-rls.ts. Каждый tenant видит только свои строки.

ALTER TABLE metrology_reminder_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrology_reminder_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_metrology_reminder_log ON metrology_reminder_log;
CREATE POLICY tenant_isolation_metrology_reminder_log ON metrology_reminder_log
  USING (tenant_id = current_tenant_id());
