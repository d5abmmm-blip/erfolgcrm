-- RLS для кэша AI-сводки (ai_daily_summaries).
-- Запускается setup-rls.ts (вне drizzle journal). Изоляция по tenant_id.

ALTER TABLE ai_daily_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_daily_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ai_daily_summaries ON ai_daily_summaries
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
