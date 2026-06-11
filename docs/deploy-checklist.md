# Чек-лист боевого деплоя ErfolgCRM v2

Цель: пошаговый рецепт первого запуска CRM в продакшене для ООО «Эрфольг» с учётом 152-ФЗ. Документ — внутренний, не отдаётся клиенту.

Стек: Node 22 + pnpm 10, PostgreSQL 16, Redis 7, BullMQ, S3-совместимое хранилище (Yandex Object Storage), nginx как frontend для статики и TLS.

---

## 0. Pre-flight (до того как трогать сервер)

| Что | Зачем |
|---|---|
| Домен `crm.erfolg-md.ru` (или `erfolgcrm.ru`) | Для SSL и cookie. Поддомен короче, проще DNS. |
| DNS A-record на IP сервера | TTL 300 секунд на момент запуска (на случай быстрой смены). |
| Хостинг в РФ | 152-ФЗ ст. 18 ч. 5: ПДн граждан РФ хранятся на серверах в РФ. Подходят: **Selectel** (СПб/Москва), **Yandex Cloud** (зоны ru-central1-*), **VK Cloud**, **RU-VDS**. НЕ подходят: AWS, Hetzner, DigitalOcean. |
| Уведомление в РКН | До начала обработки ПДн — подать уведомление об операторе на pd.rkn.gov.ru. У ООО «Эрфольг» уже подано (проверить, что код деятельности совпадает: ремонт медицинского оборудования). |
| Согласие ПДн на сайте | Образец см. в `samples/`. Для физлиц — обязательная галочка при создании заявки на сайте (если есть лендинг). В CRM физлица заводит инженер вручную — согласие подписывается на бумаге одновременно с актом приёма. |
| Резервный канал связи | Сотовый телефон админа сервера + второй админ (на случай отпуска). |

### TLS / SSL

```bash
# На сервере (Ubuntu 24.04 / Debian 12), уже установлен nginx
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d crm.erfolg-md.ru
# Автообновление уже в systemd timer (certbot.timer). Проверить:
sudo systemctl status certbot.timer
```

Альтернатива: купить SSL у российского УЦ (если требует юротдел).

---

## 1. Сервер: ОС и системные пакеты

Минимум: 4 vCPU, 8 GB RAM, 80 GB SSD. PostgreSQL и Redis — на той же машине (можно вынести в managed-сервис у Selectel/Yandex Cloud).

```bash
# Базовое
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx postgresql-16 postgresql-contrib redis-server build-essential

# Node 22 через nvm (избегаем системных пакетов)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22
npm install -g pnpm@10

# Firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow http
sudo ufw allow https
sudo ufw enable
```

---

## 2. PostgreSQL 16

```bash
# Включить расширения (от postgres superuser'а)
sudo -u postgres psql <<'SQL'
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- Owner: создаёт схему, владеет таблицами
CREATE USER erfolg WITH PASSWORD 'CHANGE_ME_OWNER_PASSWORD';
CREATE DATABASE erfolg_prod OWNER erfolg;

-- Runtime: подключается приложение, RLS обязательна
CREATE USER app_runtime WITH PASSWORD 'CHANGE_ME_RUNTIME_PASSWORD';
GRANT CONNECT ON DATABASE erfolg_prod TO app_runtime;
SQL

# В erfolg_prod: расширения и права
sudo -u postgres psql -d erfolg_prod <<'SQL'
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gin";
GRANT USAGE ON SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR USER erfolg IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR USER erfolg IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
SQL
```

`pg_hba.conf` — оставить `local md5` и `host ... 127.0.0.1/32 md5`. Снаружи Postgres не открывать.

### Бэкапы (pg_dump + cron, retention 30 дней)

```bash
sudo mkdir -p /var/backups/erfolg && sudo chown postgres /var/backups/erfolg
sudo -u postgres crontab -e
# добавить:
# 0 3 * * * pg_dump -Fc erfolg_prod -f /var/backups/erfolg/erfolg_$(date +\%F).dump && find /var/backups/erfolg -name 'erfolg_*.dump' -mtime +30 -delete
```

Раз в неделю руками копировать дамп в Yandex Object Storage (отдельный bucket с versioning + Object Lock на 30 дней).

---

## 3. Redis 7

`/etc/redis/redis.conf`:
```
bind 127.0.0.1
requirepass CHANGE_ME_REDIS_PASSWORD
maxmemory 512mb
maxmemory-policy allkeys-lru
appendonly yes
```
```bash
sudo systemctl restart redis-server
```

---

## 4. Код приложения

```bash
sudo useradd -m -s /bin/bash erfolgcrm
sudo -u erfolgcrm bash -c '
  cd ~
  git clone <ваш-репозиторий> erfolgcrm
  cd erfolgcrm
  pnpm install --frozen-lockfile
  pnpm build
'
```

### .env (положить в `/home/erfolgcrm/erfolgcrm/.env`, права 600)

Скопировать из `.env.example` и заменить ВСЕ `change_me_*`. Минимально:

| Переменная | Как получить |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | `openssl rand -base64 64` |
| `PII_ENCRYPTION_KEY` | `node scripts/generate-pii-key.mjs` |
| `DATABASE_URL` | `postgresql://app_runtime:PASS@localhost:5432/erfolg_prod` |
| `DATABASE_OWNER_URL` | `postgresql://erfolg:PASS@localhost:5432/erfolg_prod` |
| `REDIS_URL` | `redis://:PASS@localhost:6379` |
| `STORAGE_DRIVER` | `s3` |
| `S3_*` | Из консоли Yandex Object Storage (отдельный сервисный аккаунт с правами на 1 bucket) |
| `SMTP_HOST/USER/PASSWORD` | Yandex 360 / Mail.ru Business |
| `VAPID_PUBLIC_KEY/PRIVATE_KEY` | `npx web-push generate-vapid-keys` (один раз) |
| `WORKERS_ENABLED` | `true` (single-node) или `false` если воркеры — отдельный systemd-юнит |
| `INVOICE_REMINDER_ENABLED` | `true` после прогона smoke-тестов |
| `TELEGRAM_DEV_BOT_TOKEN` | Опционально, токены per-tenant — в БД |

### Миграции и RLS (один раз при первом деплое)

```bash
cd /home/erfolgcrm/erfolgcrm
pnpm --filter @erfolg/db migrate
pnpm --filter @erfolg/db tsx src/setup-rls.ts
```

Создание директора (вручную, потом сменит пароль через UI):
```bash
pnpm --filter @erfolg/api tsx -e "
import { hash } from 'argon2';
import { getDb, users, withoutTenantTx } from '@erfolg/db';
const db = getDb();
const passHash = await hash('TempPass!Change');
await withoutTenantTx(db, async (tx) => {
  await tx.insert(users).values({
    tenantId: '<UUID-tenant-erfolg>', email: 'director@erfolg-md.ru',
    passwordHash: passHash, role: 'director', fullName: 'Директор'
  });
});
"
```

---

## 5. systemd-юниты

`/etc/systemd/system/erfolgcrm-api.service`:
```ini
[Unit]
Description=ErfolgCRM API
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=erfolgcrm
WorkingDirectory=/home/erfolgcrm/erfolgcrm
EnvironmentFile=/home/erfolgcrm/erfolgcrm/.env
# tsx, а не dist: workspace-пакеты (@erfolg/db, @erfolg/shared) экспортируют
# TypeScript-источники, поэтому `node apps/api/dist/index.js` упадёт на их импорте.
ExecStart=/home/erfolgcrm/.nvm/versions/node/v22.0.0/bin/node apps/api/node_modules/.bin/tsx apps/api/src/index.ts
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now erfolgcrm-api
sudo systemctl status erfolgcrm-api
```

(Опционально — отдельный юнит `erfolgcrm-workers.service` с `WORKERS_ENABLED=true` и `WORKERS_ONLY=true`, в API-юните `WORKERS_ENABLED=false`. Сейчас можно держать в одном процессе.)

### nginx

`/etc/nginx/sites-available/erfolgcrm`:
```nginx
server {
  listen 443 ssl http2;
  server_name crm.erfolg-md.ru;
  ssl_certificate /etc/letsencrypt/live/crm.erfolg-md.ru/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/crm.erfolg-md.ru/privkey.pem;

  client_max_body_size 25M; # фото актов

  # ── Защитные заголовки (аудит 2026-06-11) ─────────────────────────────
  # HSTS: браузер ходит только по https (31536000 = год)
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  # Камера нужна PWA инженеров (фото актов, сканер штрихкодов)
  add_header Permissions-Policy "camera=(self), microphone=(), geolocation=()" always;
  # CSP — заготовка. Включать ПОСЛЕ проверки в staging (Vite-бандл, pdfmake
  # и web-push могут требовать корректировок):
  # add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:" always;

  location /api/ {
    proxy_pass http://127.0.0.1:3030;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }

  location / {
    root /home/erfolgcrm/erfolgcrm/apps/web/dist;
    try_files $uri /index.html;
    add_header Cache-Control "no-cache" always;
  }
}

server {
  listen 80;
  server_name crm.erfolg-md.ru;
  return 301 https://$host$request_uri;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/erfolgcrm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 6. Smoke-тесты (после первого старта)

| # | Что | Ожидается |
|---|---|---|
| 1 | `curl https://crm.erfolg-md.ru/health` | `{"status":"ok"}` |
| 2 | Открыть в браузере, залогиниться директором | Редирект на дашборд, нет 500 в Network |
| 3 | Создать клиента-физлицо «Тест Тестов» с телефоном | Сохранился. В БД проверить: `SELECT full_name_encrypted FROM contacts LIMIT 1` — bytea, не plaintext. |
| 4 | Создать заявку → перевести в наряд → сгенерировать PDF договора РО | PDF скачивается, в шапке `#29ABE2`/`#F26522`. |
| 5 | `SELECT count(*) FROM audit_logs WHERE created_at > now() - interval '1 hour'` | > 0 (минимум create-events для клиента и заявки). |
| 6 | `redis-cli -a PASS llen bull:storage-cleanup:wait` | Любое число (очередь жива). |
| 7 | Положить фото 5 МБ через PhotoUploader инженера | Файл оказался в Yandex Object Storage bucket. |

Если что-то падает — `journalctl -u erfolgcrm-api -n 200 --no-pager`.

---

## 7. Rollback-план

### Откат миграции
Drizzle `down` миграции мы не пишем (политика проекта). Откат — ручной SQL-скрипт, обратный к последней миграции в `packages/db/drizzle/migrations/`. Перед деплоем новой миграции:

1. Сделать `pg_dump -Fc erfolg_prod` (точечный, кроме ночного).
2. Применить миграцию.
3. Если что-то сломалось:
   ```bash
   sudo systemctl stop erfolgcrm-api
   sudo -u postgres dropdb erfolg_prod
   sudo -u postgres createdb -O erfolg erfolg_prod
   sudo -u postgres pg_restore -d erfolg_prod /var/backups/erfolg/erfolg_<DATE>.dump
   git checkout <prev-tag>
   pnpm install --frozen-lockfile && pnpm build
   sudo systemctl start erfolgcrm-api
   ```

### Откат кода без отката БД
Если миграция backward-compatible (только добавили колонку, например):
```bash
cd /home/erfolgcrm/erfolgcrm && git checkout <prev-tag>
pnpm install --frozen-lockfile && pnpm build
sudo systemctl restart erfolgcrm-api
```

---

## 8. Мониторинг (минимум, без Grafana)

Что проверять глазами раз в день первую неделю, потом — по алертам:

| Источник | Что искать | Команда |
|---|---|---|
| journalctl API | ERROR / FATAL | `journalctl -u erfolgcrm-api -p err -S today` |
| PostgreSQL slow log | Запросы > 500 мс | `tail -f /var/log/postgresql/postgresql-16-main.log` (включить `log_min_duration_statement = 500` в `postgresql.conf`) |
| BullMQ failed | Зависшие задачи | `redis-cli -a PASS llen bull:invoice-reminder:failed` (и для каждой очереди) |
| Redis memory | Не превышает `maxmemory` | `redis-cli -a PASS info memory` |
| Дисковое место | < 80% | `df -h /` |
| Backup | Свежий дамп есть | `ls -lh /var/backups/erfolg/ | tail` |
| audit_logs | Запись идёт | `SELECT max(created_at) FROM audit_logs` (должно быть в пределах часа активности) |

Когда вырастем — Sentry уже подключается через `SENTRY_DSN` в `.env` (заглушка готова).

---

## 9. Безопасность инфраструктуры (повторить раз в квартал)

- [ ] Все пароли в `.env` — длинные, рандомные, разные.
- [ ] `PII_ENCRYPTION_KEY` лежит ТОЛЬКО в `.env` сервера + offline-копия у директора. Не в git, не в чатах, не в облачных заметках.
- [ ] `chmod 600 .env` и owner = `erfolgcrm`.
- [ ] `apt update && apt upgrade -y` — раз в неделю.
- [ ] Certbot обновляет SSL автоматически — проверить `systemctl status certbot.timer`.
- [ ] PostgreSQL и Redis слушают только 127.0.0.1.
- [ ] SSH — только по ключу, `PasswordAuthentication no` в `/etc/ssh/sshd_config`.
- [ ] Бэкапы за последние 30 дней есть и проверены восстановлением (раз в квартал — пробное восстановление в `erfolg_test`).
