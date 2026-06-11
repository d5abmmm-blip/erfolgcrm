/**
 * Этап 7-A: Web Push подписки.
 *
 * Один пользователь может иметь несколько активных подписок (телефон, рабочий браузер, домашний).
 * endpoint уникален глобально (это URL push-сервиса браузера) — UNIQUE без tenant_id.
 *
 * При 410 Gone от push-сервиса воркер ставит revoked_at, чтобы больше не слать.
 */
import { pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { fkUuid, pk, tenantId } from './_shared';

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: pk(),
    tenantId: tenantId(),
    userId: fkUuid('user_id'),
    /** URL пуш-сервиса браузера (FCM/Mozilla/etc). Уникален глобально. */
    endpoint: varchar('endpoint', { length: 1024 }).notNull(),
    /** ECDSA P-256 publicKey base64url (auth-ключ) */
    p256dh: varchar('p256dh', { length: 200 }).notNull(),
    auth: varchar('auth', { length: 200 }).notNull(),
    userAgent: varchar('user_agent', { length: 500 }),
    /** Устанавливается при 410 Gone от push-сервиса — не слать больше. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('push_subscriptions_endpoint_uniq').on(t.endpoint)],
);
