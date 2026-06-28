#!/usr/bin/env bash
#
# Авто-бэкап боевой БД ErfolgCRM (PostgreSQL в Docker-контейнере).
#
# Делает сжатый дамп (pg_dump -Fc, формат для pg_restore) в каталог бэкапов
# и удаляет дампы старше BACKUP_KEEP_DAYS. Безопасно для боевой БД (только чтение).
#
# Установка на сервере (РАЗОВО):
#   chmod +x /root/erfolgcrm/scripts/prod/backup-db.sh
#   ( crontab -l 2>/dev/null; \
#     echo '0 3 * * * /root/erfolgcrm/scripts/prod/backup-db.sh >> /root/backups/backup.log 2>&1' ) | crontab -
#   # проверить разовый прогон:
#   /root/erfolgcrm/scripts/prod/backup-db.sh && ls -laht /root/backups | head
#
# Восстановление из дампа:
#   docker exec -i erfolgcrm-postgres-prod pg_restore -U erfolg -d erfolg_prod --clean --if-exists < <дамп>.dump
#
set -euo pipefail

CONTAINER="${BACKUP_PG_CONTAINER:-erfolgcrm-postgres-prod}"
DB="${BACKUP_PG_DB:-erfolg_prod}"
PGUSER_="${BACKUP_PG_USER:-erfolg}"
DIR="${BACKUP_DIR:-/root/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"

mkdir -p "$DIR"
TS="$(date +%F-%H%M%S)"
OUT="$DIR/erfolg_prod_auto_${TS}.dump"

# -Fc = custom (сжатый) формат, восстанавливается через pg_restore
docker exec "$CONTAINER" pg_dump -U "$PGUSER_" -Fc "$DB" > "$OUT"

# Проверка целостности: дамп не должен быть пустым
if [ ! -s "$OUT" ]; then
  echo "$(date '+%F %T') ERROR: пустой дамп, удаляю $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

echo "$(date '+%F %T') OK: $OUT ($(du -h "$OUT" | cut -f1))"

# Ротация: удаляем авто-дампы старше KEEP_DAYS дней (ручные pre-deploy-* не трогаем)
find "$DIR" -maxdepth 1 -name 'erfolg_prod_auto_*.dump' -mtime +"$KEEP_DAYS" -delete
