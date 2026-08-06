/**
 * Общие колонки и хелперы для всех таблиц.
 * Все ID — UUID v7 (timestamp-prefix), генерируется на стороне приложения через uuidv7.
 * timestampы — timestamptz, всегда UTC.
 */
import { customType, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** UUID v7 PK — генерируем в приложении, fallback gen_random_uuid() в БД для надёжности */
export const pk = () =>
  uuid('id')
    .primaryKey()
    .notNull()
    .default(sql`gen_random_uuid()`);

/** UUID FK — uuid NOT NULL, без PK. Для колонок типа user_id, plan_id и т.п. */
export const fkUuid = (name: string) => uuid(name).notNull();

/** Tenant FK — обязателен на каждой таблице кроме control plane */
export const tenantId = () => uuid('tenant_id').notNull();

/** Стандартные временные метки */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

/** Зашифрованное ПДн-поле через pgcrypto. Хранится как bytea. */
export const encryptedText = (name: string) =>
  customType<{ data: string; driverData: Buffer }>({
    dataType: () => 'bytea',
    toDriver: (v) => Buffer.from(v, 'utf-8'),
    fromDriver: (v) => v.toString('utf-8'),
  })(name);

/** Короткое название для уникальных кодов (subdomain, plan code и т.п.) */
export const slug = (name: string, length = 64) => varchar(name, { length }).notNull();
