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
# Отдельно проверяется РАСШИФРОВКА ПДн. Раньше скрипт считал только количество строк и
# писал «VERIFY OK» — то есть горел зелёным даже в случае, когда ФИО и телефоны физлиц
# уже нечитаемы, потому что ключ (PII_ENCRYPTION_KEY) не тот или потерян. Обнаружилось бы
# это только в катастрофе, когда чинить поздно. Теперь несовпадение ключа = VERIFY FAILED.
#
# Еженедельный крон (РАЗОВО):
#   chmod +x /root/erfolgcrm/scripts/prod/verify-restore.sh
#   ( crontab -l 2>/dev/null; \
#     echo '30 4 * * 0 /bin/bash /root/erfolgcrm/scripts/prod/verify-restore.sh >> /root/backups/verify.log 2>&1' ) | crontab -
#
set -uo pipefail

CONTAINER="${BACKUP_PG_CONTAINER:-erfolgcrm-postgres-prod}"
API_CONTAINER="${BACKUP_API_CONTAINER:-erfolgcrm-api-prod}"
PGUSER_="${BACKUP_PG_USER:-erfolg}"
DIR="${BACKUP_DIR:-/root/backups}"
TESTDB="${VERIFY_TEST_DB:-erfolg_restore_verify}"
# Корень проекта: скрипт лежит в <корень>/scripts/prod/, поэтому поднимаемся на два уровня.
PROJECT_DIR="${BACKUP_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

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

# ───────── Расшифровка ПДн: главная проверка ─────────
# Строки в таблицах — ещё не «данные вернулись». ФИО и телефоны физлиц лежат
# зашифрованными (pgp_sym_encrypt ключом PII_ENCRYPTION_KEY). Не тот ключ — pgp_sym_decrypt
# падает с ошибкой, и это единственный способ узнать заранее, что данные уже не восстановить.
#
# Ключ берём ИЗ ЖИВОГО api-контейнера: так проверяется именно тот ключ, которым
# приложение шифрует сейчас. Фолбэк — .env проекта, затем переменная окружения.
PII_KEY="$(docker exec "$API_CONTAINER" printenv PII_ENCRYPTION_KEY 2>/dev/null)"
if [ -z "${PII_KEY:-}" ] && [ -f "$PROJECT_DIR/.env" ]; then
  PII_KEY="$(grep -E '^PII_ENCRYPTION_KEY=' "$PROJECT_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi
[ -z "${PII_KEY:-}" ] && PII_KEY="${PII_ENCRYPTION_KEY:-}"

if [ -z "${PII_KEY:-}" ]; then
  log "VERIFY FAILED: не удалось получить PII_ENCRYPTION_KEY — расшифровку ПДн проверить нечем" >&2
  exit 1
fi

# Сколько всего зашифрованных ФИО физлиц есть в копии.
ENC_TOTAL="$(docker exec "$CONTAINER" psql -U "$PGUSER_" -d "$TESTDB" -At \
  -c "SELECT count(*) FROM clients WHERE full_name_encrypted IS NOT NULL" 2>/dev/null)"

if [ -z "${ENC_TOTAL:-}" ] || [ "$ENC_TOTAL" = "0" ]; then
  # Не проваливаем: у свежей инсталляции физлиц может не быть вовсе.
  log "WARN: в копии нет зашифрованных ФИО — расшифровку проверить не на чем" >&2
else
  # Ключ передаём через stdin, а не аргументом: иначе он был бы виден в `ps` любому
  # процессу на хосте. В лог печатаем только длину результата, не сам текст (это ПДн).
  DEC_LEN="$(printf '%s' "
    SELECT length(pgp_sym_decrypt(full_name_encrypted::bytea, '$PII_KEY')::text)
    FROM clients WHERE full_name_encrypted IS NOT NULL LIMIT 1;
  " | docker exec -i "$CONTAINER" psql -U "$PGUSER_" -d "$TESTDB" -At -f - 2>/dev/null)"

  if [ -z "${DEC_LEN:-}" ] || ! [ "$DEC_LEN" -gt 0 ] 2>/dev/null; then
    log "VERIFY FAILED: ПДн НЕ РАСШИФРОВЫВАЮТСЯ ($ENC_TOTAL зашифрованных ФИО в копии)." >&2
    log "  Ключ PII_ENCRYPTION_KEY не подходит к этой копии. Данные физлиц из неё" >&2
    log "  восстановить НЕЛЬЗЯ. Найдите верный ключ, пока живой сервер ещё работает." >&2
    exit 1
  fi
  log "OK: ПДн расшифровываются (проверено на 1 из $ENC_TOTAL, длина ФИО $DEC_LEN симв.)"
fi

log "VERIFY OK: $LATEST разворачивается начисто, с данными и с читаемыми ПДн"
