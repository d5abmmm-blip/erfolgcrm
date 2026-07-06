#!/bin/bash
# DEV/generic ONLY. Работает с ПЛОСКИМ форматом (erfolg-*.sql.gz от scripts/backup.sh),
# восстанавливая через 'gunzip | psql'. Боевой ночной крон (scripts/prod/backup-db.sh)
# делает custom-format 'erfolg_prod_auto_*.dump' в /root/backups — его psql не читает.
# Для проверки боевых дампов используй scripts/prod/verify-restore.sh (pg_restore).
#
# Восстанавливает последний бэкап в TEST_PG_URL и прогоняет 3 sanity-SELECT'а.
# Если хоть один SELECT упал ИЛИ вернул 0 — exit 1.
#
# ENV:
#   BACKUP_DIR    /var/backups/erfolg                                       (обязательно)
#   TEST_PG_URL   postgresql://erfolg:pass@host:5432/erfolg_restore_test    (обязательно, чистая БД!)
set -euo pipefail

: "${BACKUP_DIR:?need BACKUP_DIR}"
: "${TEST_PG_URL:?need TEST_PG_URL}"

LATEST=$(ls -t "$BACKUP_DIR"/erfolg-*.sql.gz 2>/dev/null | head -1)
if [ -z "${LATEST:-}" ]; then
  echo "[verify] no backups found in $BACKUP_DIR" >&2
  exit 1
fi
echo "[verify] using $LATEST"

echo "[verify] restoring → $TEST_PG_URL"
gunzip -c "$LATEST" | psql "$TEST_PG_URL" > /dev/null

run_check() {
  local label="$1"; local query="$2"
  local result
  result=$(psql "$TEST_PG_URL" -At -c "$query")
  if [ -z "$result" ] || [ "$result" = "0" ]; then
    echo "[verify] FAIL: $label → '$result'"
    return 1
  fi
  echo "[verify] OK: $label = $result"
  return 0
}

FAILED=0
run_check "tickets-alive"      "SELECT count(*) FROM tickets WHERE deleted_at IS NULL"             || FAILED=1
run_check "users-active"       "SELECT count(*) FROM users WHERE is_active = true"                  || FAILED=1
run_check "audit-recent-7d"    "SELECT count(*) FROM audit_logs WHERE ts > NOW() - INTERVAL '7 days'" || FAILED=1

if [ "$FAILED" -ne 0 ]; then
  echo "[verify] FAIL — backup восстанавливается, но данные пустые/битые"
  exit 1
fi
echo "[verify] OK — backup пригоден"
