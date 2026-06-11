# control-plane — архив (2026-06-11)

SaaS-портал (регистрация тенантов, биллинг/ЮKassa). Заархивирован при переводе
ErfolgCRM v2 в личный single-tenant режим — код сохранён, из workspace исключён.

Как вернуть:
1. Переместить этот каталог обратно в `apps/control-plane`.
2. Вернуть reference `./apps/control-plane` в корневой `tsconfig.json`.
3. Вернуть скрипт `"dev:control-plane"` в корневой `package.json` (и при желании — в `dev`).
4. `pnpm install`.

Примечание: в `apps/control-plane/` мог остаться пустой каталог `node_modules`
(на момент архивации был залочен процессом Windows) — его можно удалить после
перезагрузки; без `package.json` pnpm и tsc его игнорируют.

Таблицы БД `plans` / `subscriptions` НЕ удалялись: они инертны, на них завязаны
RLS-политики из `0001_enable_rls.sql` и schema-файл `packages/db/src/schema/tenants.ts`.
