-- RLS для kb_articles (Stage 12 — база знаний).
-- Применяется setup-rls.ts. Каждый tenant видит только свои статьи.

ALTER TABLE kb_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_articles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_kb_articles ON kb_articles;
CREATE POLICY tenant_isolation_kb_articles ON kb_articles
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
