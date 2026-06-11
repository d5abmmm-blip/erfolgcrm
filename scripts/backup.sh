#!/bin/bash
# pg_dump → gzip → BACKUP_DIR/erfolg-YYYYMMDD-HHMM.sql.gz
# Чистит файлы старше RETENTION_DAYS (default 30).
#
# ENV:
#   PG_URL          postgresql://erfolg:pass@host:5432/erfolg_prod   (обязательно)
#   BACKUP_DIR      /var/backups/erfolg                              (обязательно)
#   RETENTION_DAYS  30                                                (опц., default)
set -euo pipefail

: "${PG_URL:?need PG_URL}"
: "${BACKUP_DIR:?need BACKUP_DIR}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
TS=$(date -u +%Y%m%d-%H%M)
OUT="$BACKUP_DIR/erfolg-$TS.sql.gz"

echo "[backup] dumping → $OUT"
pg_dump --no-owner --no-privileges --format=plain "$PG_URL" | gzip -9 > "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup] done ($SIZE)"

echo "[backup] cleaning files older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -name 'erfolg-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete
echo "[backup] OK"
