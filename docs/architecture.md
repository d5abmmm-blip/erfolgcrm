# Архитектура ErfolgCRM v2

> **Этап**: 0 (Фундамент). Документ растёт по мере реализации.

## Высокоуровневая схема

```
                  ┌───────────────────────────┐
                  │ app.erfolgcrm.ru          │
   Покупатели ───▶│ Control Plane             │
                  │ (регистрация, биллинг)    │
                  └───────────┬───────────────┘
                              │
                  ┌───────────▼───────────────┐
   Пользователи  │ <tenant>.erfolgcrm.ru     │
   tenant'а      │ Web App (React PWA)        │
                  │ адаптивный desktop+mobile  │
                  └───────────┬───────────────┘
                              │ tRPC v11
                  ┌───────────▼───────────────┐
   Telegram ────▶│ API Backend (Node + Express)│
   клиенты       │ • multi-tenant middleware  │
                  │ • RBAC                     │
                  │ • AuditLog                 │
                  └─┬───────┬───────┬─────────┘
                    │       │       │
              ┌─────▼─┐ ┌──▼──┐ ┌──▼──────┐
              │ PG 16 │ │Redis│ │S3 (YOS)│
              └───────┘ └─────┘ └────────┘
```

## Multi-tenant изоляция (защита от утечек)

Эшелонированная защита — если упадёт один слой, остальные удержат:

1. **tRPC middleware** `tenantGuard` ([apps/api/src/trpc/trpc.ts](../apps/api/src/trpc/trpc.ts)) — резолвит `tenant_id` из subdomain + сессии, форсит наличие в контексте.
2. **Drizzle helper** `tenantScoped()` (Этап 1) — оборачивает все queries, добавляет `WHERE tenant_id = $current`. ESLint-правило запретит прямые queries без него.
3. **PostgreSQL RLS** — включён на каждой таблице с `tenant_id` (Этап 1). Если разработчик забудет фильтр — БД просто не вернёт чужие строки.
4. **Cross-tenant test suite** — автоматический e2e набор: «логин под tenant A → запрос с ID из tenant B → 403/404». Запускается на каждый PR.
5. **Code review checklist** — каждый новый router проходит проверку «фильтрует по tenant_id?».

## Слои в каждом модуле

```
src/modules/<name>/
├── domain/        — чистая бизнес-логика без I/O (вызывается из service)
├── repository.ts  — Drizzle queries (через tenantScoped)
├── service.ts     — use cases, оркестрация
├── router.ts      — tRPC endpoints
├── index.ts       — ПУБЛИЧНЫЙ API модуля (только это импортируется снаружи)
└── __tests__/
```

## Стек

| Слой | Что |
|---|---|
| Frontend | React 19 + Vite 7 + Tailwind 4 + shadcn/ui + TanStack Query 5 + Zustand 5 + zod 4 + wouter |
| Backend | Node.js 22 + Express 5 + tRPC 11 + Drizzle 0.38 + Argon2id + BullMQ |
| БД | PostgreSQL 16 + pgcrypto + RLS |
| Файлы | Yandex Object Storage (S3) |
| Кэш/очереди | Redis 7 |
| Bot | grammy (отдельный процесс, webhook) |
| Деплой | Docker + Yandex Compute Cloud + Terraform |

## ID и ключи

- ID везде — UUID v7 (timestamp-prefix → лучше для индексов).
- `tenant_id` обязателен на всех таблицах кроме `tenants`, `plans`, `subscriptions`, `audit_logs_global`.
- Шифрование ПДн полей (ФИО, телефоны, адреса физлиц) — pgcrypto, ключ per-tenant в Yandex KMS.
