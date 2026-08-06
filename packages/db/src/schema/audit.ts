/**
 * AuditLog — обязательное требование 152-ФЗ.
 * Пишется при ЛЮБОМ изменении любой сущности.
 * Хранится 5 лет (152-ФЗ + бухучёт).
 */
import { jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { fkUuid, pk, tenantId } from './_shared';

export const auditActionEnum = pgEnum('audit_action', [
  'create',
  'update',
  'delete',
  'restore',
  'login',
  'logout',
  'login_failed',
  'password_changed',
  'role_changed',
  'export',
  'consent_given',
  'consent_revoked',
  'schedule_change',
]);

/**
 * AuditLog для tenant-scoped действий.
 * before/after — JSON-снимки до и после (только изменившиеся поля).
 */
export const auditLogs = pgTable('audit_logs', {
  id: pk(),
  tenantId: tenantId(),
  userId: uuid('user_id'), // null для системных действий (cron)
  action: auditActionEnum('action').notNull(),
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityId: varchar('entity_id', { length: 100 }), // varchar потому что не везде uuid
  before: jsonb('before'),
  after: jsonb('after'),
  ip: varchar('ip', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  context: jsonb('context'), // дополнительные метаданные (например, причина отмены заявки)
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Block A (pivot single-company): control plane больше нет, audit_logs_global удалён
 * (см. миграцию 0027_security_hardening.sql). Оставляем заметку в комментарии на случай
 * будущего возрождения SaaS-режима — тогда таблицу заведём заново.
 */

/**
 * Записи согласий на обработку ПДн.
 * 152-ФЗ: должны быть свидетельства согласия для каждого субъекта ПДн.
 */
export const consentTypeEnum = pgEnum('consent_type', [
  'pdn_processing', // согласие на обработку ПДн (общее, при регистрации)
  'pdn_processing_client', // согласие клиента-физлица на обработку при создании заявки
  'marketing', // согласие на маркетинг (опционально)
  'cookie', // согласие на куки в личном кабинете
]);

export const consentRecords = pgTable('consent_records', {
  id: pk(),
  tenantId: tenantId(),
  /** Subject — кто дал согласие. Может быть user_id (наш пользователь) или client_id (клиент сервиса) */
  subjectType: varchar('subject_type', { length: 20 }).notNull(), // 'user' | 'client'
  subjectId: fkUuid('subject_id'),
  consentType: consentTypeEnum('consent_type').notNull(),
  /** Версия документа политики, на момент согласия */
  policyVersion: varchar('policy_version', { length: 20 }).notNull(),
  /** Текст согласия (что именно подписали) — для неоспоримости */
  consentText: varchar('consent_text', { length: 2000 }).notNull(),
  ip: varchar('ip', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),
  /** Дано или отозвано? */
  givenAt: timestamp('given_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
