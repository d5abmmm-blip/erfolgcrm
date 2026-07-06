# Резервные копии ErfolgCRM — рунбук (боевой сервер)

Что бэкапится, чем, как восстановить и как это проверять. Актуально для прода
`crm.erfolgmt.ru` (сервер `claw.thesafebridge.com`, БД `erfolg_prod` в контейнере
`erfolgcrm-postgres-prod`, файлы в томе `storage_data` → `/data/storage`).

## Что бэкапится (2 части — обе нужны для полного восстановления)

| Часть | Что | Чем | Куда |
|-------|-----|-----|------|
| **База данных** | клиенты, заявки, счета, оплаты, архив ИИ и т.д. | `pg_dump -Fc` (custom) | `/root/backups/erfolg_prod_auto_*.dump` |
| **Файлы вложений** | сканы, фото, PDF (в БД лежат только ссылки `object_key`) | `tar` тома `storage_data` | `/root/backups/erfolg_prod_files_*.tar.gz` |

> ⚠️ Без части «Файлы» восстановление БД даст записи о вложениях с **битыми ссылками** —
> сами файлы не вернутся. Поэтому бэкапим обе части одним скриптом.

## Кроны (root crontab)

```cron
# Ежедневный бэкап БД + файлов, 03:00. Вызов через /bin/bash — НЕ зависит от бита +x
# (git reset --hard на деплое сбрасывает права файла; bash его игнорирует).
0 3 * * * /bin/bash /root/erfolgcrm/scripts/prod/backup-db.sh >> /root/backups/backup.log 2>&1

# Еженедельная проверка восстановимости (воскресенье 04:30), в одноразовую БД.
30 4 * * 0 /bin/bash /root/erfolgcrm/scripts/prod/verify-restore.sh >> /root/backups/verify.log 2>&1
```

Ротация: авто-копии (`erfolg_prod_auto_*.dump`, `erfolg_prod_files_*.tar.gz`) старше
`BACKUP_KEEP_DAYS` (по умолчанию 30) удаляются. Ручные `pre-deploy-*.dump` не трогаются.

## Установка/переустановка скриптов (РАЗОВО на сервере)

```bash
ssh -i ~/.ssh/claw root@claw.thesafebridge.com
chmod +x /root/erfolgcrm/scripts/prod/backup-db.sh /root/erfolgcrm/scripts/prod/verify-restore.sh
# разовый прогон бэкапа:
/bin/bash /root/erfolgcrm/scripts/prod/backup-db.sh && ls -laht /root/backups | head
# разовый прогон проверки:
/bin/bash /root/erfolgcrm/scripts/prod/verify-restore.sh
```

## Восстановление

**База (в НОВУЮ БД, боевую не трогая — так проверяют дамп):**
```bash
docker exec erfolgcrm-postgres-prod createdb -U erfolg erfolg_restore_test
docker exec -i erfolgcrm-postgres-prod pg_restore -U erfolg -d erfolg_restore_test \
  --no-owner --no-privileges < /root/backups/erfolg_prod_auto_<дата>.dump
# ... сверить данные ...
docker exec erfolgcrm-postgres-prod dropdb -U erfolg erfolg_restore_test
```

**База (перезапись боевой — ТОЛЬКО осознанно, после бэкапа текущего состояния):**
```bash
docker exec -i erfolgcrm-postgres-prod pg_restore -U erfolg -d erfolg_prod \
  --clean --if-exists < /root/backups/erfolg_prod_auto_<дата>.dump
```

**Файлы:** распаковать архив в точку монтирования тома `storage_data`:
```bash
VOL=$(docker inspect erfolgcrm-api-prod \
  -f '{{range .Mounts}}{{if eq .Destination "/data/storage"}}{{.Name}}{{end}}{{end}}')
VP=$(docker volume inspect "$VOL" -f '{{ .Mountpoint }}')
tar xzf /root/backups/erfolg_prod_files_<дата>.tar.gz -C "$VP"
```

## Как понять, что бэкап здоров (еженедельный ручной чек)

Раз в неделю глазами:
```bash
ls -laht /root/backups | head            # есть СЕГОДНЯШНИЕ *.dump И *_files_*.tar.gz
tail -n 5 /root/backups/backup.log       # последняя строка — 'OK db:' (не ERROR/Permission denied)
tail -n 10 /root/backups/verify.log      # последняя строка — 'VERIFY OK'
crontab -l | grep -E 'backup-db|verify-restore'   # обе строки на месте
```
Здоровое состояние: за сегодня есть и дамп БД, и архив файлов; в `backup.log` — `OK db:`;
в `verify.log` — `VERIFY OK` не старше недели.

## Если упало

| Симптом | Что значит | Действие |
|---------|-----------|----------|
| `backup.log` кончается на `ERROR`/`Permission denied` | ночной бэкап не сделался | запустить руками `/bin/bash .../backup-db.sh`, разобрать stderr в `/root/backups/backup.err` |
| нет сегодняшнего `*_files_*.tar.gz`, но `.dump` есть | архив файлов пропущен (api пересоздавался / гонка с деплоем) | перезапустить бэкап вручную; если повторяется — проверить том `storage_data` |
| `verify.log` = `VERIFY FAILED` | свежий дамп не разворачивается | НЕ удалять старые копии; проверить более ранний дамп через `verify-restore.sh`, эскалировать |

## ⚠️ Известные пробелы (решение владельца — см. хэндофф Блока 2)

- **Нет копии ВНЕ сервера.** Дамп, архив файлов и сама БД лежат на одном диске. Гибель/шифровальщик/
  отзыв VM уносит всё разом. Нужна выгрузка свежих копий в Yandex Object Storage / на второй хост.
- **Нет авто-оповещения о сбое.** Провал ночного бэкапа виден только в `backup.log` (владелец его не
  читает). Нужен канал алерта (почта `MAILTO=` / Telegram / healthchecks.io dead-man switch).
- **152-ФЗ: копии не шифруются.** В `/root/backups` — ПДн в открытом виде (сканы актов + незашифрованные
  поля дампа: адреса, наименования орг-клиентов, тексты заявок; ФИО/тел/e-mail и тело писем — шифрованы
  pgcrypto). Диск должен оставаться на РФ-хостинге с ограниченным доступом; при выгрузке вовне —
  шифровать (age/gpg, ключ офлайн у директора). Зафиксировать как осознанное решение.

## Прочее

- **Кнопка «Скачать полную копию базы»** (Настройки → Резервные копии, только директор):
  считает дамп на лету через `pg_dump` в api-контейнере (режим `direct`, креды owner-роли
  `erfolg` из `DATABASE_OWNER_URL`). Требует `postgresql16-client` в образе api (добавлен
  в `apps/api/Dockerfile`).
- **Хранилище на проде** — локальное (`STORAGE_DRIVER=local`, `LOCAL_STORAGE_DIR=/data/storage`),
  том `storage_data`. Не S3.
- `scripts/verify-backup.sh` — dev/generic (плоский `.sql.gz` от `scripts/backup.sh`), для боевых
  `.dump` не годится; используйте `scripts/prod/verify-restore.sh`.
