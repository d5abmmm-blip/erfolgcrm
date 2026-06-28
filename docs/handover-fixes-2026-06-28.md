# Предсдаточные правки 2026-06-28 — что применить на проде

Ветка `fix/pre-handover-audit-2026-06-28`. Здесь — что нужно сделать НА СЕРВЕРе после ревью/мержа.
Код-правки (хранилище, гонка оплаты, RBAC поиска, токен бэкапа) применяются обычным деплоем
(см. [memory] project_production_deploy). Ниже — отдельные серверные шаги.

## 1. 🔴 Авто-бэкап боевой БД (БЛОКЕР B2)

Скрипт уже в репо: `scripts/prod/backup-db.sh`. На сервере разово:

```bash
ssh -i ~/.ssh/claw root@claw.thesafebridge.com
chmod +x /root/erfolgcrm/scripts/prod/backup-db.sh
# проверка разового прогона:
/root/erfolgcrm/scripts/prod/backup-db.sh && ls -laht /root/backups | head
# добавить в cron (03:00 ежедневно, лог в /root/backups/backup.log):
( crontab -l 2>/dev/null; echo '0 3 * * * /root/erfolgcrm/scripts/prod/backup-db.sh >> /root/backups/backup.log 2>&1' ) | crontab -
crontab -l   # убедиться, что строка добавилась (рядом с чужим MySQL-кроном)
```

Восстановление из дампа: `docker exec -i erfolgcrm-postgres-prod pg_restore -U erfolg -d erfolg_prod --clean --if-exists < <дамп>.dump`

## 2. 🔴 Файловое хранилище (БЛОКЕР B1)

Чинится КОДОМ (правка guard в `apps/api/src/lib/object-storage.ts`): теперь `STORAGE_DRIVER=local`
в production разрешён, если задан `LOCAL_STORAGE_DIR`. На проде он уже задан (`/data/storage`,
смонтирован как том) — **достаточно задеплоить ветку**, доп. ENV не нужен. После деплоя проверить:
загрузить фото в заявке/в ИИ-ассистенте → файл сохраняется, открывается (раньше падало 500).
В БД появится строка в `attachments`.

## 3. 🟠 Авто-письма клиентам не уходят (H2)

Причина: воркеры (`ticket-status-notify`, `invoice-reminder`) шлют через ENV `SMTP_*`, а на проде
он ПУСТОЙ. Раздел «Почта» (email_configs) работает — авто-письма нет. Два варианта:

**Вариант A (быстрый, ENV).** Задать в `/root/erfolgcrm/.env` (хост — `mail.hosting.reg.ru`, НЕ домен!):
```
SMTP_HOST=mail.hosting.reg.ru
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=info@erfolgmt.ru
SMTP_PASSWORD=<пароль ящика>
MAIL_FROM=info@erfolgmt.ru
```
Затем `docker compose ... up -d api`. Проверка: сменить статус тестовой заявки → письмо приходит.

**Вариант B (правильный, КОД — рекомендовано).** Перевести воркеры на единый источник `email_configs`
(тогда не надо дублировать креды в ENV). Это отдельная правка — НЕ входит в текущую ветку.

## 4. 🟡 Web-push инженерам (опц.)

VAPID-ключей на проде нет → push мёртв. Если push нужен:
```bash
npx web-push generate-vapid-keys   # положить в .env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```
+ задать `VITE_VAPID_PUBLIC_KEY` для фронта (сверить имя переменной), пересобрать web. Иначе — оставить выключенным.

## 5. 🟡 152-ФЗ: предупреждение про ИИ (H3)

Содержимое загруженных в ИИ-ассистент файлов/сканов уходит во внешний LLM **z.ai (КНР)**.
Рекомендуется добавить в UI ассистента одноразовое предупреждение «файлы и текст уходят
ИИ-провайдеру (z.ai); не загружайте ПДн граждан без согласия» — отдельная UI-правка.
