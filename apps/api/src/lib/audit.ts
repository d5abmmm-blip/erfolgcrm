/**
 * AuditLog writer.
 *
 * Используется во ВСЕХ service-методах при изменении сущностей.
 * 152-ФЗ требует журнала всех операций с ПДн (before/after, пользователь, IP).
 *
 * Запись делается через withTenantTx, чтобы RLS-политика пропустила (audit_logs тоже под RLS).
 *
 * Block A: добавлен writeAuditInTx — пишет в УЖЕ открытой транзакции (атомарность с мутацией).
 * Это критично для бизнес-инвариантов: либо мутация + аудит вместе, либо ничего.
 *
 * Block A: маскирование PII в context — если ключи 'email'/'phone'/'passport'/'inn'
 * присутствуют в context, прогоняем через mask-хелперы (предотвращает утечку ПДн в audit).
 */
import { auditLogs, withTenantTx, type Db } from '@erfolg/db';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { maskPiiInContext } from './mask';

type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'password_changed'
  | 'role_changed'
  | 'export'
  | 'consent_given'
  | 'consent_revoked'
  | 'schedule_change';

interface AuditEntry {
  userId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  context?: Record<string, unknown> | null;
}

/**
 * Тип tenant-scoped транзакции. Совпадает с приватным TenantTx из @erfolg/db/with-tenant.ts —
 * вызовы из service-методов передают `tx` из callback'а withTenantTx.
 */
type TenantTx = PgTransaction<never, never, never>;

function buildInsertValues(tenantId: string, entry: AuditEntry) {
  return {
    tenantId,
    userId: entry.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, 500) ?? null,
    // Block A: PII-маскирование context перед записью.
    context: maskPiiInContext(entry.context) ?? null,
  };
}

/**
 * Записать audit-event, открыв собственную транзакцию.
 * Совместимо со всеми существующими call-site'ами.
 */
export async function writeAudit(db: Db, tenantId: string, entry: AuditEntry): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.insert(auditLogs).values(buildInsertValues(tenantId, entry));
  });
}

/**
 * Записать audit-event в УЖЕ открытой tenant-tx.
 * Используй когда мутация и аудит должны быть атомарны (rollback мутации = rollback аудита).
 *
 * Пример:
 *   await withTenantTx(db, tenantId, async (tx) => {
 *     await tx.insert(tickets).values(...);
 *     await writeAuditInTx(tx, tenantId, { action: 'create', entityType: 'ticket', ... });
 *   });
 */
export async function writeAuditInTx(
  tx: TenantTx,
  tenantId: string,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(auditLogs).values(buildInsertValues(tenantId, entry));
}
