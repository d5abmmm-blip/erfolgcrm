-- Включаем Row Level Security как defense-in-depth.
-- Если разработчик забудет фильтр по tenant_id в Drizzle-запросе,
-- RLS вернёт 0 строк (вместо данных другого tenant'а).
--
-- Принцип:
-- - На каждой tenant-aware таблице включаем RLS.
-- - FORCE RLS — чтобы политика применялась даже к OWNER (иначе owner = superuser bypass).
-- - Политика проверяет tenant_id = current_setting('app.current_tenant_id').
-- - В каждой транзакции делаем `SELECT set_config('app.current_tenant_id', $1, true)`.
--   Параметр true = LOCAL (только в этой транзакции).
--
-- Управляющие таблицы (tenants, plans, audit_logs_global) — БЕЗ RLS,
-- к ним обращается control plane.

-- Хелпер-функция: текущий tenant_id из настройки сессии. NULL если не задан.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
$$;

-- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id = current_tenant_id());

-- sessions
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_sessions ON sessions
  USING (tenant_id = current_tenant_id());

-- audit_logs
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (tenant_id = current_tenant_id());

-- consent_records
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_consent_records ON consent_records
  USING (tenant_id = current_tenant_id());

-- subscriptions (под особым режимом — control plane может читать всё, tenant видит свою)
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_subscriptions ON subscriptions
  USING (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL);
-- ↑ NULL разрешает control plane (где app.current_tenant_id не задан) видеть все подписки
--   для биллинга. Tenant видит только свою.
