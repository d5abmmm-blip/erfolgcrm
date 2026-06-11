/**
 * Клиенты сервисного центра и их контактные лица.
 *
 * Типы клиентов:
 * - legal/commercial — коммерческое юрлицо (ООО, ИП), счёт по реквизитам
 * - legal/budget     — бюджетная организация (ГБУ, ФГБУ, ГАУ), три счёта казначейства
 * - individual       — физлицо. ФИО, телефон, адрес шифруются через pgcrypto.
 *
 * subtype применим только к type='legal' (DB CHECK constraint).
 *
 * contacts — представители клиники (главный инженер, начальник отдела закупок и т.п.).
 * Их ФИО и личный телефон по 152-ФЗ — персональные данные, шифруются.
 */
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { encryptedText, fkUuid, pk, tenantId, timestamps } from './_shared';

export const clientTypeEnum = pgEnum('client_type', ['legal', 'individual']);
export const clientSubtypeEnum = pgEnum('client_subtype', ['commercial', 'budget']);
export const clientStatusEnum = pgEnum('client_status', ['active', 'archived']);

export const clients = pgTable(
  'clients',
  {
    id: pk(),
    tenantId: tenantId(),

    type: clientTypeEnum('type').notNull(),
    /** Применим только когда type='legal'. Для individual всегда NULL. */
    subtype: clientSubtypeEnum('subtype'),

    /**
     * Что показывается в списках/поиске.
     * - legal: название организации («ООО Стом. клиника Улыбка», «ГБУ Грозненская ЦРБ»)
     * - individual: инициалы («Иванов И.И.») — НЕ полное ФИО (полное лежит в fullNameEncrypted)
     */
    displayName: varchar('display_name', { length: 200 }).notNull(),

    /** Реквизиты юрлица (plain — не PII) */
    inn: varchar('inn', { length: 12 }),
    kpp: varchar('kpp', { length: 9 }),
    ogrn: varchar('ogrn', { length: 15 }),
    legalAddress: text('legal_address'),
    /** Рабочий телефон организации (plain). Для individual — NULL, реальный телефон в phoneEncrypted. */
    phone: varchar('phone', { length: 50 }),
    /** Рабочий email организации (plain). */
    email: varchar('email', { length: 200 }),

    /** Реквизиты бюджетника (заполняются только при subtype='budget') */
    treasuryAccount: varchar('treasury_account', { length: 20 }),
    eksAccount: varchar('eks_account', { length: 20 }),
    personalAccount: varchar('personal_account', { length: 20 }),

    /** ПДн физлица — шифрование через pgcrypto, заполняются только при type='individual' */
    fullNameEncrypted: encryptedText('full_name_encrypted'),
    phoneEncrypted: encryptedText('phone_encrypted'),
    addressEncrypted: encryptedText('address_encrypted'),

    /**
     * Контакт по умолчанию для подстановки в документы. FK на contacts.id, ON DELETE SET NULL.
     * Циклический FK добавляется отдельно через ALTER TABLE в миграции (Drizzle не умеет).
     */
    defaultContactId: uuid('default_contact_id'),

    notes: text('notes'),

    status: clientStatusEnum('status').notNull().default('active'),

    ...timestamps,
  },
  (t) => [
    /** Поиск по ИНН (точное совпадение). Не unique — у филиалов один ИНН. */
    index('clients_tenant_inn_idx').on(t.tenantId, t.inn),
    /** Поиск ILIKE по названию */
    index('clients_tenant_displayname_idx').on(t.tenantId, t.displayName),
    /** Фильтр в списке клиентов */
    index('clients_tenant_status_idx').on(t.tenantId, t.status),
    /** subtype может быть задан только для юрлица */
    check(
      'clients_subtype_legal_only',
      sql`subtype IS NULL OR type = 'legal'`,
    ),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: pk(),
    tenantId: tenantId(),
    clientId: fkUuid('client_id'),

    /** ПДн контактного лица — обязательны и зашифрованы */
    fullNameEncrypted: encryptedText('full_name_encrypted').notNull(),
    phoneEncrypted: encryptedText('phone_encrypted').notNull(),

    /** Рабочий email — plain, не считаем PII в B2B-контексте */
    email: varchar('email', { length: 200 }),
    /** Должность («главный инженер», «начальник отдела закупок») — plain */
    position: varchar('position', { length: 100 }),

    /** Главный контакт клиента. Принудительно один на клиента (partial unique index). */
    isPrimary: boolean('is_primary').notNull().default(false),

    ...timestamps,
  },
  (t) => [
    index('contacts_tenant_client_idx').on(t.tenantId, t.clientId),
    /**
     * Не более одного primary-контакта на клиента.
     * Drizzle не умеет partial unique через уровневый API — добавляется в миграции отдельным SQL.
     */
    uniqueIndex('contacts_one_primary_per_client')
      .on(t.tenantId, t.clientId)
      .where(sql`is_primary = true`),
  ],
);
