-- RLS для calendar_events. Запускается setup-rls.ts (вне drizzle journal).
-- Изоляция по tenant_id через current_tenant_id() (app.current_tenant_id, см. withTenantTx).

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_calendar_events ON calendar_events
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
