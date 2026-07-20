/**
 * tenantScoped() — задумывалась как обёртка для tenant-aware запросов.
 *
 * ⚠️ НЕ ИСПОЛЬЗУЕТСЯ. Ни один модуль её не вызывает, а обещанного ESLint-правила
 * («прямые запросы без обёртки запрещены») не существует. Не принимайте эту
 * функцию за работающую защиту от утечек между компаниями.
 *
 * Что защищает НА САМОМ ДЕЛЕ:
 *   1. `withTenantTx` — открывает транзакцию, выставляя текущий tenant для RLS.
 *      Через него идут все запросы (~155 файлов);
 *   2. RLS на уровне Postgres — политики на каждой таблице с tenant_id;
 *   3. тесты, проверяющие, что чужие данные не отдаются.
 *
 * Оставлена как есть, чтобы не трогать публичный экспорт пакета в правках
 * документации. Если решите, что она не нужна, — файл можно удалить целиком.
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
