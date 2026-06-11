/**
 * tenantScoped() — обязательная обёртка для tenant-aware запросов.
 *
 * Защита от cross-tenant утечек: каждый запрос автоматически добавляет
 * WHERE tenant_id = $current. Прямые db.select().from(...) без этой обёртки
 * запрещены ESLint-правилом (см. eslint.config.js).
 *
 * RLS на уровне Postgres — defense-in-depth, если разработчик забудет.
 *
 * Использование:
 *   const userRepo = tenantScoped(db, ctx.tenantId);
 *   await userRepo.from(users).where(eq(users.id, ...));
 */
import { and, eq, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from './client';

export interface TenantScopedDb {
  readonly tenantId: string;
  readonly db: Db;

  /** SELECT с автоматической фильтрацией по tenant_id */
  scopedWhere<T extends PgTable & { tenantId: { name: string } }>(
    table: T,
    extra?: SQL<unknown>,
  ): SQL<unknown>;
}

/**
 * Создаёт обёртку для запросов в рамках одного tenant'а.
 * Передаётся через tRPC context, не создаётся вручную.
 */
export function tenantScoped(db: Db, tenantId: string): TenantScopedDb {
  if (!tenantId) {
    throw new Error('tenantScoped: tenantId is required (would leak across tenants!)');
  }
  return {
    tenantId,
    db,
    scopedWhere(table, extra) {
      // table.tenantId — Drizzle column reference
      const tenantCol = (table as unknown as { tenantId: never }).tenantId;
      const base = eq(tenantCol, tenantId);
      return extra ? (and(base, extra) as SQL<unknown>) : base;
    },
  };
}
