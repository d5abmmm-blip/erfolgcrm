#!/bin/bash
# Восстановление дампа в БД. Перезапишет все данные!
#
# ENV:
#   PG_URL       postgresql://erfolg:pass@host:5432/erfolg_target  (обязательно)
#   BACKUP_FILE  /var/backups/erfolg/erfolg-20260503-1200.sql.gz   (обязательно)
set -euo pipefail

: "${PG_URL:?need PG_URL}"
: "${BACKUP_FILE:?need BACKUP_FILE}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "[restore] file not found: $BACKUP_FILE" >&2
  exit 1
fi

echo "ВНИМАНИЕ: восстановление перезапишет БД по адресу $PG_URL"
echo "Backup file: $BACKUP_FILE"
read -r -p "Введите 'yes' для продолжения: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "[restore] отменено"
  exit 1
fi

echo "[restore] gunzip + psql ..."
gunzip -c "$BACKUP_FILE" | psql "$PG_URL"
echo "[restore] OK"
