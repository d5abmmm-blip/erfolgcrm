/**
 * Stage 10'.H — Кабинет клиента.
 *
 * client_users — учётки сотрудников клиники (главбух/директор клиники/снабженец),
 * которые входят в свой кабинет по email + паролю и видят свои:
 *   • заявки (tickets WHERE client_id = их client_id)
 *   • технику (assets WHERE owner_client_id = их client_id)
 *   • счета (invoices WHERE client_id = ...)
 *   • договоры (contracts WHERE client_id = ...)
 *
 * Это ОТДЕЛЬНЫЙ namespace от users (staff). Логины не пересекаются.
 *
 * client_sessions — отдельные сессии (cookie name 'client_session_token').
 */
import { boolean, index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

export const clientUsers = pgTable(
  'client_users',
  {
    id: pk(),
    tenantId: tenantId(),
    /** Какому клиенту принадлежит пользователь. ON DELETE CASCADE. */
    clientId: fkUuid('client_id'),

    /** Email — логин. Уникален case-insensitive в пределах tenant'а среди живых. */
    email: varchar('email', { length: 200 }).notNull(),

    /** Argon2id хеш */
    passwordHash: varchar('password_hash', { length: 500 }).notNull(),

    /** ФИО контактного лица (для приветствия в кабинете) */
    fullName: varchar('full_name', { length: 200 }).notNull(),

    /** Должность (главбух / директор клиники / снабженец) */
    position: varchar('position', { length: 200 }),

    phone: varchar('phone', { length: 50 }),

    isActive: boolean('is_active').notNull().default(true),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    lastLoginIp: varchar('last_login_ip', { length: 45 }),

    /**
     * 152-ФЗ DSAR: момент, когда пользователь нажал "удалить аккаунт" в кабинете.
     * Не означает мгновенного удаления — данные хранятся за бухгалтерским сроком (5 лет),
     * фактическая физическая зачистка через cron вне рамок текущей итерации.
     * Физический ALTER TABLE — миграция 0037.
     */
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('client_users_tenant_email_lower_uniq')
      .on(t.tenantId, sql`lower(${t.email})`)
      .where(sql`deleted_at IS NULL`),
    index('client_users_tenant_client_idx')
      .on(t.tenantId, t.clientId)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const clientSessions = pgTable(
  'client_sessions',
  {
    id: pk(),
    tenantId: tenantId(),
    clientUserId: fkUuid('client_user_id'),
    sessionToken: varchar('session_token', { length: 64 }).notNull().unique(),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 500 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('client_sessions_token_idx').on(t.sessionToken),
    index('client_sessions_tenant_user_idx').on(t.tenantId, t.clientUserId),
  ],
);
