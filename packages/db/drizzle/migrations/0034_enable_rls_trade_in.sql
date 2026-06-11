-- RLS для trade_in_items. Запускается setup-rls.ts (вне drizzle journal).

ALTER TABLE trade_in_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_in_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_trade_in_items ON trade_in_items
  USING (tenant_id = current_tenant_id());
