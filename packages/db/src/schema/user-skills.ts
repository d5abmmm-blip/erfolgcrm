/**
 * Навыки инженера — какие типы техники он обслуживает (УЗИ, рентген, автоклав…).
 * Связка user ↔ device_type (тот же справочник, что assets.device_type). Используется
 * для умного назначения заявок (подсказка «подходит/не подходит») и на доске.
 *
 * RLS включается отдельным *enable_rls*.sql (см. setup-rls.ts).
 */
import { pgTable, timestamp, uniqueIndex, index, uuid, varchar } from 'drizzle-orm/pg-core';
import { pk, tenantId } from './_shared';

export const userDeviceSkills = pgTable(
  'user_device_skills',
  {
    id: pk(),
    tenantId: tenantId(),
    /** FK на users.id (app-enforced). */
    userId: uuid('user_id').notNull(),
    /** Тип оборудования из справочника device-types (напр. «УЗИ», «рентген»). */
    deviceType: varchar('device_type', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_device_skills_uniq').on(t.tenantId, t.userId, t.deviceType),
    index('user_device_skills_type_idx').on(t.tenantId, t.deviceType),
  ],
);
