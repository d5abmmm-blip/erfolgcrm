-- RLS для ticket_templates (Stage 11 — шаблоны заявок).
-- Применяется setup-rls.ts. Каждый tenant видит только свои шаблоны.

ALTER TABLE ticket_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_templates ON ticket_templates;
CREATE POLICY tenant_isolation_ticket_templates ON ticket_templates
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
