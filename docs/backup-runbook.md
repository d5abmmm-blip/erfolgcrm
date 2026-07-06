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

## Копия вне сервера (off-box)

Автоматической выгрузки вне сервера пока НЕТ (осознанное решение на этапе сдачи). Интерим-стратегия —
**раз в неделю директор вручную скачивает свежую копию БД на свой ПК** кнопкой «Скачать полную копию
базы» (Настройки → Резервные копии) и хранит на ПК/внешнем диске, оставленном в РФ.
⚠️ Кнопка отдаёт только БД; файлы вложений (`*_files_*.tar.gz`) пока остаются лишь на сервере. Когда
понадобится автоматизация — добавить rclone-выгрузку обеих частей в Yandex Object Storage (versioning +
Object Lock) и включить шифрование (см. ниже).

## Оповещение о сбое (dead-man switch)

`backup-db.sh` при заданном `BACKUP_HEALTHCHECK_URL` пингует healthchecks.io: успех → базовый URL,
провал → `.../fail`. Если ожидаемого ночного пинга нет (сервер лёг / крон не запустился), healthchecks.io
сам шлёт письмо директору — это ловит даже полный отказ, который «письмо-при-сбое» поймать не может.
URL задаётся в строке крона на сервере (в репо не хранится):
```cron
0 3 * * * BACKUP_HEALTHCHECK_URL=https://hc-ping.com/<uuid> /bin/bash /root/erfolgcrm/scripts/prod/backup-db.sh >> /root/backups/backup.log 2>&1
```
Настройка: завести бесплатный check на healthchecks.io (period 1 day, grace ~2 hours), вписать его
ping-URL в строку крона. Требуется `curl` на хосте.

## 152-ФЗ: шифрование копий — принятый риск

Копии в `/root/backups` лежат в открытом виде (сканы актов + незашифрованные поля дампа: адреса,
наименования орг-клиентов, тексты заявок; ФИО/тел/e-mail и тело писем — уже шифрованы pgcrypto). Решение
владельца на этапе сдачи: **оставить как есть**, полагаясь на РФ-хостинг и ограниченный root-доступ; НЕ
выгружать копии на внешние сервисы без шифрования. Если появится off-box в облако — включить age/gpg с
офлайн-ключом у директора.

## Прочее

- **Кнопка «Скачать полную копию базы»** (Настройки → Резервные копии, только директор):
  считает дамп на лету через `pg_dump` в api-контейнере (режим `direct`, креды owner-роли
  `erfolg` из `DATABASE_OWNER_URL`). Требует `postgresql16-client` в образе api (добавлен
  в `apps/api/Dockerfile`).
- **Хранилище на проде** — локальное (`STORAGE_DRIVER=local`, `LOCAL_STORAGE_DIR=/data/storage`),
  том `storage_data`. Не S3.
- `scripts/verify-backup.sh` — dev/generic (плоский `.sql.gz` от `scripts/backup.sh`), для боевых
  `.dump` не годится; используйте `scripts/prod/verify-restore.sh`.
