-- RLS для таблицы attachments. Запускается setup-rls.ts (вне drizzle journal).

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_attachments ON attachments
  USING (tenant_id = current_tenant_id());
