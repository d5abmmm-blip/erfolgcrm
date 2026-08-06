/**
 * Control plane: tenants, plans, subscriptions.
 * Эти таблицы — БЕЗ tenant_id (они и есть про tenant'ов).
 */
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, slug, timestamps } from './_shared';

export const tenantStatusEnum = pgEnum('tenant_status', [
  'trial',
  'active',
  'suspended',
  'cancelled',
]);
export const planCodeEnum = pgEnum('plan_code', ['start', 'pro', 'corp']);

/**
 * Tenant — отдельный сервисный центр (клиент SaaS).
 * Поля реквизитов извлечены из реальных бланков ООО Эрфольг
 * (см. memory/project_real_documents.md).
 */
export const tenants = pgTable(
  'tenants',
  {
    id: pk(),

    /** Subdomain: <name>.erfolgcrm.ru. Уникален глобально, иммутабелен после создания. */
    subdomain: slug('subdomain', 63),

    /** Краткое отображаемое имя ("ООО Эрфольг"). */
    displayName: varchar('display_name', { length: 200 }).notNull(),

    /** Юридическое полное наименование ("Общество с ограниченной ответственностью «Эрфольг»"). */
    legalName: varchar('legal_name', { length: 500 }),

    /** Слоган в шапке документов ("Техническое обслуживание и ремонт медицинской техники"). */
    slogan: varchar('slogan', { length: 300 }),

    /** Реквизиты компании */
    inn: varchar('inn', { length: 12 }),
    kpp: varchar('kpp', { length: 9 }),
    ogrn: varchar('ogrn', { length: 15 }),
    legalAddress: text('legal_address'),
    phone: varchar('phone', { length: 50 }),
    email: varchar('email', { length: 200 }),

    /** Банковские реквизиты */
    bankName: varchar('bank_name', { length: 300 }),
    bankAccount: varchar('bank_account', { length: 20 }),
    correspondentAccount: varchar('correspondent_account', { length: 20 }),
    bik: varchar('bik', { length: 9 }),

    /** Лицензия на ремонт медтехники (Росздравнадзор) — обязательна для оказания услуг */
    licenseSeries: varchar('license_series', { length: 20 }),
    licenseNumber: varchar('license_number', { length: 50 }),
    licenseDate: timestamp('license_date', { withTimezone: false }),
    licenseAuthority: varchar('license_authority', { length: 200 }),

    /** Часовой пояс tenant'а — все timestamp в БД UTC, конвертация в UI */
    timezone: varchar('timezone', { length: 50 }).notNull().default('Europe/Moscow'),

    /** Статус tenant'а: trial → active → suspended → cancelled */
    status: tenantStatusEnum('status').notNull().default('trial'),

    /** Идентификатор ключа шифрования в Yandex KMS (для pgcrypto колонок). В dev — пусто. */
    kmsKeyId: varchar('kms_key_id', { length: 200 }),

    /**
     * Разделы (модули) интерфейса, отключённые директором — массив ключей модулей
     * (см. apps/web/src/lib/modules.ts). Пусто = все разделы включены.
     *
     * Отключение влияет ТОЛЬКО на навигацию и маршруты UI: данные и API остаются
     * живыми, поэтому скрыть можно лишь те разделы, без которых не ломается логика
     * (ядро — Дашборд/Заявки/Клиенты/Настройки — в этот список не попадает).
     */
    disabledModules: jsonb('disabled_modules')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /**
     * Фича B — тумблер уведомления клиента по e-mail, когда техника готова к выдаче
     * (заявка переходит в статус act_pending). Это письмо уже отправляется воркером
     * ticket-status-notify; тумблер позволяет директору его ОТКЛЮЧИТЬ. ПО УМОЛЧАНИЮ
     * ВКЛЮЧЕНО (true) — чтобы поведение прода, где письмо уже шлётся, не изменилось.
     * Без email у клиента письмо тихо не отправляется.
     */
    notifyClientWhenReady: boolean('notify_client_when_ready').notNull().default(true),

    ...timestamps,
  },
  (t) => [unique('tenants_subdomain_unique').on(t.subdomain)],
);

/**
 * Тарифные планы SaaS.
 * Лимиты в JSONB: { maxUsers, maxClients, maxAssetsPerMonth, hasTelegramBot, hasMaintenanceLog, hasOneCExport }.
 */
export const plans = pgTable(
  'plans',
  {
    id: pk(),
    code: planCodeEnum('code').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    monthlyPriceRub: integer('monthly_price_rub').notNull(),
    yearlyPriceRub: integer('yearly_price_rub').notNull(),
    features: jsonb('features')
      .$type<{
        maxUsers: number | null; // null = безлимит
        maxClients: number | null;
        maxTicketsPerMonth: number | null;
        hasTelegramBot: boolean;
        hasMaintenanceLog: boolean;
        hasOneCExport: boolean;
        hasCustomBranding: boolean;
        hasPrioritySupport: boolean;
      }>()
      .notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [unique('plans_code_unique').on(t.code)],
);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trial',
  'active',
  'past_due',
  'cancelled',
]);

/**
 * Подписка tenant'а на план. У tenant'а в каждый момент только одна активная.
 */
export const subscriptions = pgTable('subscriptions', {
  id: pk(),
  tenantId: fkUuid('tenant_id'), // FK на tenants.id, одна активная на tenant
  planId: fkUuid('plan_id'),
  status: subscriptionStatusEnum('status').notNull().default('trial'),
  trialUntil: timestamp('trial_until', { withTimezone: true }),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true })
    .notNull()
    .defaultNow(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
  cancelAt: timestamp('cancel_at', { withTimezone: true }),
  yookassaSubscriptionId: varchar('yookassa_subscription_id', { length: 100 }),
  ...timestamps,
});
