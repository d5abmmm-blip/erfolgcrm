/**
 * Пользователи внутри tenant'а.
 * username уникален в рамках (tenant_id, username), не глобально.
 * email опционален (для восстановления пароля + приглашений).
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, jsonb, pgEnum, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { encryptedText, fkUuid, pk, tenantId, timestamps } from './_shared';

export const userRoleEnum = pgEnum('user_role', ['director', 'dispatcher', 'engineer']);

export const users = pgTable(
  'users',
  {
    id: pk(),
    tenantId: tenantId(),

    /** Логин (как в 1С) — уникален в рамках tenant'а. Регистронезависимый. */
    username: varchar('username', { length: 64 }).notNull(),

    /** Email для восстановления пароля и уведомлений. Опционален. */
    email: varchar('email', { length: 200 }),

    /** Argon2id хеш */
    passwordHash: varchar('password_hash', { length: 200 }).notNull(),

    /** Отображаемое имя (ФИО) */
    fullName: varchar('full_name', { length: 200 }).notNull(),

    /** Должность (для печати в подписях документов) */
    position: varchar('position', { length: 100 }),

    /** Роль — на этапе 1 хардкод 3 значения. Permissions гранулярные через role_permissions придут позже. */
    role: userRoleEnum('role').notNull(),

    /** Активный пользователь? Заблокированные не могут логиниться. */
    isActive: boolean('is_active').notNull().default(true),

    /** Phone — для будущего 2FA через SMS (директор) и для PWA-инженера */
    phone: varchar('phone', { length: 50 }),

    /**
     * Привязка к Telegram-чату tenant-бота (нуджи инженерам с кнопками).
     * NULL — не привязан. Уникален в рамках tenant'а (частичный индекс).
     */
    telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' }),

    /**
     * Этап 8.C — Внутренняя ставка инженера за один час (копейки).
     * Используется для snapshot cost_per_unit в work_order_lines.
     * Для не-engineer ролей значение игнорируется (хранится 0 по умолчанию).
     */
    hourlyCostRateKopecks: bigint('hourly_cost_rate_kopecks', { mode: 'bigint' }).notNull().default(0n),

    /**
     * Индивидуальная ЗП сотрудника: персональный оклад (копейки) + бонус % от работ.
     * Оба NULL ⇒ действует глобальное правило engineer_payout_rules (обратная совместимость).
     * Задав хотя бы одно, сотрудник переходит на схему «оклад + бонус» со своими цифрами.
     * Работает для любой роли (диспетчер/директор на чистом окладе — bonus 0, работ нет).
     */
    payoutBaseSalaryKopecks: bigint('payout_base_salary_kopecks', { mode: 'bigint' }),
    payoutBonusPercent: integer('payout_bonus_percent'),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    lastLoginIp: varchar('last_login_ip', { length: 45 }),

    /**
     * Stage 10'.C — 2FA TOTP. NULL во всех трёх ⇒ 2FA не включена.
     * totpSecretEnc хранится зашифрованным (pgp_sym_encrypt PII-ключом).
     * recoveryCodesHashes — массив argon2-хешей одноразовых кодов восстановления (10 шт).
     */
    totpSecretEnc: encryptedText('totp_secret_enc'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    recoveryCodesHashes: jsonb('recovery_codes_hashes').$type<string[]>(),

    ...timestamps,
  },
  (t) => [
    // Username уникален в рамках tenant'а (case-insensitive)
    uniqueIndex('users_tenant_username_unique').on(t.tenantId, t.username),
    // Email уникален в рамках tenant'а если задан
    uniqueIndex('users_tenant_email_unique').on(t.tenantId, t.email),
    // Один Telegram-чат — один сотрудник в рамках tenant'а
    uniqueIndex('users_tenant_telegram_chat_unique')
      .on(t.tenantId, t.telegramChatId)
      .where(sql`telegram_chat_id IS NOT NULL`),
  ],
);

/**
 * Активные сессии. Хранятся в Redis для скорости, но дублируются в БД для аудита и
 * принудительного logout (например, при увольнении сотрудника).
 *
 * sessionToken — это id сессии (uuid v7), не сам куки. Cookie содержит подписанный sessionToken.
 */
export const sessions = pgTable('sessions', {
  id: pk(),
  tenantId: tenantId(),
  userId: fkUuid('user_id'),
  sessionToken: varchar('session_token', { length: 64 }).notNull().unique(),
  ip: varchar('ip', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
