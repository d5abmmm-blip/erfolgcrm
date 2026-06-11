-- RLS для intake_checklists и intake_checklist_items (Stage 10'.J).
-- Применяется setup-rls.ts. Каждый tenant видит только свои чек-листы и пункты.

ALTER TABLE intake_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_checklists FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_intake_checklists ON intake_checklists;
CREATE POLICY tenant_isolation_intake_checklists ON intake_checklists
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE intake_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_checklist_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_intake_checklist_items ON intake_checklist_items;
CREATE POLICY tenant_isolation_intake_checklist_items ON intake_checklist_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
