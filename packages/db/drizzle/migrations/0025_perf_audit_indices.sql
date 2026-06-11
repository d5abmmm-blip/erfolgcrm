-- Производительные индексы для audit_logs.
-- Все запросы отчёта/UI идут с фильтром по tenant_id и сортировкой по ts DESC.
-- Без этих индексов на большой таблице получаем seq scan.
--
-- RLS уже включён на audit_logs (миграция 0001_enable_rls.sql) — индексы работают
-- поверх него, отдельный enable_rls файл не нужен.

CREATE INDEX IF NOT EXISTS audit_logs_tenant_ts_idx
  ON audit_logs USING btree (tenant_id, ts DESC);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_entity_ts_idx
  ON audit_logs USING btree (tenant_id, entity_type, ts DESC);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_user_ts_idx
  ON audit_logs USING btree (tenant_id, user_id, ts DESC)
  WHERE user_id IS NOT NULL;
