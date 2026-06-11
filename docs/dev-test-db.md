# Тестовая база erfolg_test

Автотесты (`pnpm -r test`) ходят **не** в рабочую `erfolg_dev`, а в отдельную
базу `erfolg_test` в том же docker-Postgres. Подмена происходит в
`apps/api/src/__tests__/setup.ts`: перед первым подключением `DATABASE_URL`
заменяется на `TEST_DATABASE_URL` (или дефолт `…/erfolg_test`).

Зачем: тесты создают сотни записей с префиксами `TEST…` — раньше они
загрязняли живые списки заявок и клиентов и заставляли тесты мешать друг
другу.

## Бутстрап (однократно на новой машине)

База `erfolg_test` создаётся автоматически init-скриптом контейнера
(`infra/docker/postgres-init.sql`) — но пустой. Дальше:

```powershell
# 1. Функция для RLS-политик (в erfolg_dev её создаёт setup-rls,
#    но журнальная миграция 0027 требует её раньше — курица и яйцо).
docker exec erfolgcrm-postgres-dev psql -U erfolg -d erfolg_test -c "CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid';"

# 2. Миграции + RLS + seed — всё против erfolg_test:
$env:DATABASE_OWNER_URL='postgresql://erfolg:dev_only_password@localhost:5432/erfolg_test'
pnpm --filter @erfolg/db migrate
pnpm --filter @erfolg/db setup-rls
pnpm --filter @erfolg/db seed
```

## После новых миграций

Каждая новая миграция накатывается на обе базы:

```powershell
pnpm --filter @erfolg/db migrate            # erfolg_dev (DATABASE_OWNER_URL из .env)
$env:DATABASE_OWNER_URL='postgresql://erfolg:dev_only_password@localhost:5432/erfolg_test'
pnpm --filter @erfolg/db migrate            # erfolg_test
pnpm --filter @erfolg/db setup-rls          # если добавлялись enable_rls-файлы
```

Если тесты падают с «relation … does not exist» — забыли накатить миграцию
на erfolg_test.
