ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_attendance_records ON attendance_records
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
