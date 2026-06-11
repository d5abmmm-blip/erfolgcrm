/**
 * Единый источник правды по схеме БД.
 *
 * Принципы:
 * - Все ID — UUID v7 (timestamp-prefix)
 * - tenant_id обязателен на всех таблицах кроме tenants/plans/subscriptions
 *   (после pivot single-company audit_logs_global удалён — см. 0027_security_hardening.sql)
 * - Все timestamp — timestamptz, UTC в БД
 * - Soft delete через deleted_at (152-ФЗ требует возможности восстановления)
 * - Шифрование ПДн через pgcrypto колонки (bytea), ключ per-tenant в Yandex KMS
 *
 * На этапе 1: control plane (tenants, plans, subscriptions) + auth (users, sessions) + аудит.
 * На этапах 2+: clients, contacts, assets, tickets, work_orders и т.д.
 */
export * from './_shared';
export * from './tenants';
export * from './users';
export * from './audit';
export * from './clients';
export * from './assets';
export * from './tickets';
export * from './inventory';
export * from './maintenance';
export * from './payments';
export * from './attachments';
export * from './contracts';
export * from './notifications';
export * from './telegram';
export * from './invoices';
export * from './onec';
export * from './payroll';
export * from './attestations';
export * from './client-cabinet';
export * from './intake-checklists';
export * from './ticket-templates';
export * from './kb-articles';
export * from './leads';
export * from './warranties';
export * from './kp-versions';
export * from './trade-in';
export * from './roadmap';
