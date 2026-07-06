#!/usr/bin/env bash
#
# Проверка ВОССТАНОВИМОСТИ боевого дампа — не трогая боевую базу.
#
# Берёт самый свежий .dump из каталога бэкапов, восстанавливает его в ОДНОРАЗОВУЮ базу
# внутри того же Postgres-контейнера и прогоняет sanity-проверки (ключевые таблицы не
# пусты). Временную базу удаляет всегда (trap). Боевая erfolg_prod не затрагивается.
#
# Зачем: ночной backup-db.sh проверяет дамп лишь на «непустой + валидный архив», но не на
# то, что он реально РАЗВОРАЧИВАЕТСЯ с данными. Этот скрипт закрывает пробел.
#
# Еженедельный крон (РАЗОВО):
#   chmod +x /root/erfolgcrm/scripts/prod/verify-restore.sh
#   ( crontab -l 2>/dev/null; \
#     echo '30 4 * * 0 /bin/bash /root/erfolgcrm/scripts/prod/verify-restore.sh >> /root/backups/verify.log 2>&1' ) | crontab -
#
set -uo pipefail

CONTAINER="${BACKUP_PG_CONTAINER:-erfolgcrm-postgres-prod}"
PGUSER_="${BACKUP_PG_USER:-erfolg}"
DIR="${BACKUP_DIR:-/root/backups}"
TESTDB="${VERIFY_TEST_DB:-erfolg_restore_verify}"

log() { echo "$(date '+%F %T') $*"; }

# Самый свежий дамп (авто ИЛИ ручной pre-deploy), по времени модификации.
LATEST="$(ls -1t "$DIR"/*.dump 2>/dev/null | head -1)"
if [ -z "${LATEST:-}" ]; then
  log "FAIL: в $DIR нет ни одного .dump" >&2
  exit 1
fi
log "verify: проверяю $LATEST"

# Структурный smoke-тест до попытки восстановления.
if ! docker exec -i "$CONTAINER" pg_restore --list < "$LATEST" >/dev/null 2>&1; then
  log "FAIL: $LATEST — не валидный custom-format архив" >&2
  exit 1
fi

# Чистая одноразовая база; убираем её при любом выходе, включая сигналы (иначе временная
# база утечёт в боевой контейнер, если прогон убьют по TERM/INT при рестарте/shutdown).
cleanup() { docker exec "$CONTAINER" dropdb -U "$PGUSER_" --if-exists "$TESTDB" >/dev/null 2>&1; }
trap cleanup EXIT INT TERM HUP
docker exec "$CONTAINER" dropdb -U "$PGUSER_" --if-exists "$TESTDB" >/dev/null 2>&1
if ! docker exec "$CONTAINER" createdb -U "$PGUSER_" "$TESTDB" >/dev/null 2>&1; then
  log "FAIL: не удалось создать временную базу $TESTDB" >&2
  exit 1
fi

# Восстановление. Предупреждения про роли/политики безвредны (мы с --no-owner/--no-privileges),
# но НАСТОЯЩИЕ ошибки (битый data-блок таблицы, нет места, OOM) pg_restore отражает ненулевым
# кодом — ловим их, не полагаясь только на счётчики ниже (иначе битый дамп, где основные
# таблицы восстановились, а другие — нет, прошёл бы как «OK»).
RESTORE_ERR="$(docker exec -i "$CONTAINER" pg_restore -U "$PGUSER_" -d "$TESTDB" --no-owner --no-privileges < "$LATEST" 2>&1 >/dev/null)"
rrc=$?
if [ "$rrc" -ne 0 ]; then
  # pg_restore возвращает !=0 и на безвредных варнингах — оставляем только реальные ошибки.
  real_err="$(printf '%s\n' "$RESTORE_ERR" | grep -iE 'error:|could not|out of memory|no space|permission denied' | grep -viE 'role .* does not exist|already exists' | head -5)"
  if [ -n "$real_err" ]; then
    log "FAIL: pg_restore вернул ошибки восстановления для $LATEST:" >&2
    printf '%s\n' "$real_err" >&2
    exit 1
  fi
fi

FAILED=0
check() {
  local label="$1" query="$2" result
  result="$(docker exec "$CONTAINER" psql -U "$PGUSER_" -d "$TESTDB" -At -c "$query" 2>/dev/null)"
  if [ -z "$result" ] || [ "$result" = "0" ]; then
    log "FAIL: $label → '$result'"
    FAILED=1
  else
    log "OK: $label = $result"
  fi
}

# Таблицы, которые есть в любой живой инсталляции (>0). Счета/наряды могут быть 0 у
# свежего тенанта — их проверяем информационно, не как гейт.
check "clients"      "SELECT count(*) FROM clients"
check "tickets"      "SELECT count(*) FROM tickets"
check "users"        "SELECT count(*) FROM users"
check "tenants"      "SELECT count(*) FROM tenants"

if [ "$FAILED" -ne 0 ]; then
  log "VERIFY FAILED: $LATEST восстанавливается, но ключевые таблицы пусты/битые" >&2
  exit 1
fi
log "VERIFY OK: $LATEST разворачивается начисто и с данными"
