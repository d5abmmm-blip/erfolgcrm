# ErfolgCRM v2

CRM для сервисного центра медтехники. Изначально проектировалась как мультиарендный SaaS;
сейчас развивается как **личная single-tenant инсталляция** (см. «Личный режим» ниже) —
мультиарендное ядро (tenant_id + RLS) сохранено как defense-in-depth.

> **Статус**: основные домены реализованы (заявки, наряды, склад FEFO, ТО,
> аттестации, счета/оплаты, зарплата, кабинет клиента, 1С-обмен, Telegram), плюс перенесённые
> из v1 модули: **Лиды, Гарантии, Трейд-ин, КП с версиями, Отчёты, Дорожная карта**.
> Метрология удалена (2026-06-11, архив в `archive/metrology/`).

## Стек

| Слой | Технология |
|---|---|
| Frontend | React 19 + Vite, TypeScript strict, TanStack Query 5, Tailwind 4, zod, wouter, PWA |
| Backend | Node.js + Express, tRPC 11, Drizzle ORM, Argon2id + 2FA, BullMQ |
| База | PostgreSQL 16 + pgcrypto + RLS |
| Кэш/очереди | Redis |
| Telegram | grammy (отдельный процесс) |

## Структура

```
apps/
  web/             — React PWA (директор + диспетчер + инженер на телефоне + кабинет клиента)
  api/             — tRPC сервер (модули в apps/api/src/modules/<feature>/)
  bot/             — Telegram bot worker (без TELEGRAM_DEV_BOT_TOKEN выходит сразу — это норма)
packages/
  db/              — Drizzle schema + миграции (см. «Миграции» ниже)
  shared/          — общие zod-схемы и enum'ы
  ui/, pdf-templates/
docs/              — архитектурные доки, 152-ФЗ compliance
archive/           — заархивированный SaaS-портал control-plane (см. README-ARCHIVED.md)
```

## Быстрый старт

Требования: Node.js 22+, pnpm 10+, Docker Desktop.

```bash
pnpm install
pnpm docker:dev          # PostgreSQL :5432, Redis :6379, MailHog :8025
pnpm db:migrate          # миграции схемы
pnpm --filter @erfolg/db setup-rls   # RLS-политики + role app_runtime
pnpm --filter @erfolg/db seed        # tenants erfolg/demo + пользователи
pnpm dev                 # web + api + bot
```

После запуска:

| Что | Адрес |
|---|---|
| Web | http://localhost:5173 |
| API | http://localhost:3030 (health: `/health`, deep: `/health/deep`) |
| Кабинет клиента | http://localhost:5173/client |
| MailHog UI | http://localhost:8025 |

Логины (организация `erfolg`, подставляется автоматически в личном режиме):

| Роль | Логин | Пароль |
|---|---|---|
| Директор | `director` | `erfolg_director_2026` |
| Диспетчер | `dispatcher` | `erfolg_dispatcher_2026` |
| Инженер | `engineer` | `erfolg_engineer_2026` |

## Личный режим (single-tenant)

- `VITE_DEFAULT_TENANT=erfolg` в корневом `.env` — поле «Код организации» на логинах скрыто,
  организация подставляется автоматически. Очистить переменную — вернётся мультиарендный вход.
- `control-plane` (регистрация/биллинг/ЮKassa) заархивирован в `archive/control-plane`.
- Tenant `demo` остаётся в seed — на нём держатся тесты cross-tenant изоляции.

## Миграции (важно)

`drizzle-kit generate` в этом репо **не используется** (битая цепочка snapshot'ов).
Рабочий процесс: написать `packages/db/drizzle/migrations/NNNN_<name>.sql` руками
(+ `--> statement-breakpoint`), добавить запись в `meta/_journal.json`, затем `pnpm db:migrate`.
Для новой таблицы — отдельный `NNNN_enable_rls_<name>.sql` + запись в `STAGE_TRIGGER_TABLE`
(`packages/db/src/setup-rls.ts`), затем `pnpm --filter @erfolg/db setup-rls`.

## Тесты

```bash
pnpm --filter @erfolg/api exec vitest run src/__tests__/<file>.test.ts
```

Интеграционные тесты ходят в живую dev-БД (нужен seed). Запуск всего набора разом
flaky — файлы параллельно делят одну БД; гоняйте файлами.

## Compliance (152-ФЗ)

Шифрование ПДн физлиц через pgcrypto, AuditLog по всем мутациям, RLS-изоляция.
Оператор ПДн — сама компания (ООО «Эрфольг»), не разработчик.

⚠️ Журнал согласий `consent_records` заполняется **только** при самостоятельной
регистрации клиента в личном кабинете. Клиента, заведённого менеджером вручную,
в этом журнале не будет — согласие для таких случаев берётся вне системы.

Подробнее — `docs/152-fz-compliance.md`.

## Лицензия

Proprietary. Все права защищены.
