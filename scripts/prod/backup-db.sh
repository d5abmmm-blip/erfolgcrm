#!/usr/bin/env bash
#
# Авто-бэкап боевого ErfolgCRM (PostgreSQL в Docker-контейнере) + файлы вложений.
#
# Делает:
#   1. сжатый дамп БД (pg_dump -Fc, формат для pg_restore) в каталог бэкапов;
#   2. архив тома файлов вложений/сканов (/data/storage) — БД хранит только метаданные,
#      сами файлы лежат на диске, без них restore = битые ссылки на вложения;
#   3. ротацию: удаляет авто-копии старше BACKUP_KEEP_DAYS (ручные pre-deploy-* не трогает).
# Безопасно для боевой БД — только чтение.
#
# Установка на сервере (РАЗОВО):
#   chmod +x /root/erfolgcrm/scripts/prod/backup-db.sh
#   ( crontab -l 2>/dev/null; \
#     echo '0 3 * * * /bin/bash /root/erfolgcrm/scripts/prod/backup-db.sh >> /root/backups/backup.log 2>&1' ) | crontab -
#   # ВАЖНО: в кроне вызывать через '/bin/bash <скрипт>', а не сам файл — тогда бэкап не
#   #        зависит от бита +x, который сбрасывается при 'git reset --hard' на деплое.
#
# Восстановление:
#   БД:    docker exec -i erfolgcrm-postgres-prod pg_restore -U erfolg -d erfolg_prod --clean --if-exists < <дамп>.dump
#   Файлы: tar xzf <файлы>.tar.gz -C <точка-монтирования-тома storage_data>
# Проверка восстановимости (не трогая боевую): scripts/prod/verify-restore.sh
#
set -uo pipefail

CONTAINER="${BACKUP_PG_CONTAINER:-erfolgcrm-postgres-prod}"
API_CONTAINER="${BACKUP_API_CONTAINER:-erfolgcrm-api-prod}"
DB="${BACKUP_PG_DB:-erfolg_prod}"
PGUSER_="${BACKUP_PG_USER:-erfolg}"
DIR="${BACKUP_DIR:-/root/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
STORAGE_DEST="${BACKUP_STORAGE_DEST:-/data/storage}"

mkdir -p "$DIR"
TS="$(date +%F-%H%M%S)"
OUT="$DIR/erfolg_prod_auto_${TS}.dump"
TMP="$OUT.partial"

log() { echo "$(date '+%F %T') $*"; }

# ───────── 1. Дамп БД во ВРЕМЕННЫЙ файл, промоушен только если он валиден ─────────
# Пишем в *.partial и переименовываем в финальное имя ТОЛЬКО после проверки, что дамп
# непустой И структурно валиден (pg_restore --list). Иначе при падении pg_dump (контейнер
# лёг, нет места, обрыв на середине) на диске оставался бы 0-байтный/обрезанный файл под
# видом хорошего бэкапа — мониторинг по '*.dump' принял бы его за свежую копию.
db_ok=0
if docker exec "$CONTAINER" pg_dump -U "$PGUSER_" -Fc "$DB" > "$TMP" 2>>"$DIR/backup.err"; then
  if [ -s "$TMP" ] && docker exec -i "$CONTAINER" pg_restore --list < "$TMP" >/dev/null 2>&1; then
    mv "$TMP" "$OUT"
    log "OK db: $OUT ($(du -h "$OUT" | cut -f1))"
    db_ok=1
  else
    log "ERROR: дамп пустой или не валидный архив, удаляю $TMP" >&2
    rm -f "$TMP"
  fi
else
  log "ERROR: pg_dump завершился ошибкой, удаляю $TMP" >&2
  rm -f "$TMP"
fi

# ───────── 2. Бэкап файлов вложений (том storage_data → tar.gz) ─────────
# Файлы лежат в Docker-томе, смонтированном в api-контейнер как /data/storage. Берём
# путь тома на хосте и архивируем его напрямую (host tar, без зависимости от того, поднят
# ли api). Пустой том даёт валидный крошечный архив — это норма (вложений ещё нет).
FILES_OUT="$DIR/erfolg_prod_files_${TS}.tar.gz"
FILES_TMP="$FILES_OUT.partial"
# Имя тома: сначала спрашиваем api-контейнер (точно тот том, что смонтирован в /data/storage).
# Если api в этот момент недоступен (пересоздаётся на деплое / переименован) — фолбэк на том
# по имени, чтобы файлы не остались без бэкапа из-за гонки с деплоем.
VOL="$(docker inspect "$API_CONTAINER" \
  -f "{{range .Mounts}}{{if eq .Destination \"$STORAGE_DEST\"}}{{.Name}}{{end}}{{end}}" 2>/dev/null)"
if [ -z "$VOL" ]; then
  VOL="$(docker volume ls -q --filter "name=${BACKUP_STORAGE_VOLUME:-storage_data}" 2>/dev/null | head -1)"
  [ -n "$VOL" ] && log "WARN: $API_CONTAINER недоступен, том определён по имени: $VOL" >&2
fi
if [ -n "$VOL" ]; then
  VOL_PATH="$(docker volume inspect "$VOL" -f '{{ .Mountpoint }}' 2>/dev/null)"
  if [ -n "$VOL_PATH" ] && [ -d "$VOL_PATH" ]; then
    # tar по ЖИВОМУ тому может вернуть код 1 («file changed as we read it» — параллельная
    # загрузка вложения/входящего письма во время архивации); архив при этом ВАЛИДЕН.
    # Фатально только >=2. --warning=no-file-changed глушит шум в stderr.
    tar --warning=no-file-changed -czf "$FILES_TMP" -C "$VOL_PATH" . 2>>"$DIR/backup.err"
    trc=$?
    if [ "$trc" -le 1 ] && [ -s "$FILES_TMP" ]; then
      mv "$FILES_TMP" "$FILES_OUT"
      log "OK files: $FILES_OUT ($(du -h "$FILES_OUT" | cut -f1))"
    else
      log "ERROR: архивация файлов не удалась (tar rc=$trc), удаляю $FILES_TMP" >&2
      rm -f "$FILES_TMP"
    fi
  else
    log "WARN: путь тома '$VOL' не найден на хосте — пропускаю бэкап файлов" >&2
  fi
else
  log "WARN: том $STORAGE_DEST не найден (ни в $API_CONTAINER, ни по имени) — пропускаю бэкап файлов" >&2
fi

# ───────── 3. Ротация — ТОЛЬКО если сегодняшний дамп удался ─────────
# Ротация по возрасту без этой проверки при затяжном сбое (контейнер лёг/переименован)
# продолжала бы стирать последние ХОРОШИЕ копии, пока новые не пишутся → через KEEP_DAYS
# дней аварии на диске 0 восстановимых бэкапов. Ручные pre-deploy-* не трогаем в любом случае.
if [ "$db_ok" -eq 1 ]; then
  find "$DIR" -maxdepth 1 -name 'erfolg_prod_auto_*.dump' -mtime +"$KEEP_DAYS" -delete
  find "$DIR" -maxdepth 1 -name 'erfolg_prod_files_*.tar.gz' -mtime +"$KEEP_DAYS" -delete
else
  log "WARN: дамп не удался — ротацию пропускаю, старые копии сохраняю" >&2
fi

# Код возврата: провал именно дампа БД — это провал бэкапа (для алерта/крон-лога).
[ "$db_ok" -eq 1 ] || exit 1
