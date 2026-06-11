-- RLS для бизнес-таблиц Этапа 2: clients, contacts, assets, asset_events.
-- Применяется тем же паттерном, что 0001_enable_rls.sql:
--   - ENABLE + FORCE ROW LEVEL SECURITY (FORCE — чтобы политика срабатывала даже на owner)
--   - CREATE POLICY tenant_isolation_<table> USING (tenant_id = current_tenant_id())
--
-- Эти таблицы НЕ имеют control plane bypass (в отличие от subscriptions): они чисто
-- tenant-scoped, control plane к ним не обращается.
--
-- Запускается setup-rls.ts (а не drizzle-kit migrate) — поэтому файл вне _journal.json.
-- setup-rls перед применением делает DROP POLICY IF EXISTS — скрипт идемпотентен.

-- clients
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_clients ON clients
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- contacts
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_contacts ON contacts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- assets
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_assets ON assets
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- asset_events
ALTER TABLE asset_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_asset_events ON asset_events
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
