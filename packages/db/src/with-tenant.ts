/**
 * withTenantTx — обёртка для запросов в рамках одного tenant'а.
 *
 * Открывает транзакцию и устанавливает app.current_tenant_id для PostgreSQL RLS.
 * Все queries внутри cb автоматически фильтруются RLS-политикой по tenant_id.
 *
 * Это БЕЗОПАСНОСТЬ defense-in-depth:
 * если разработчик забудет .where(eq(table.tenantId, ...)),
 * RLS вернёт пустой результат вместо данных другого tenant'а.
 *
 * Использование:
 *   await withTenantTx(db, ctx.tenant.id, async (tx) => {
 *     return tx.select().from(users); // вернёт только users этого tenant'а
 *   });
 */
import { sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { Db } from './client';

type TenantTx = PgTransaction<never, never, never>;

export async function withTenantTx<T>(
  db: Db,
  tenantId: string,
  cb: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new Error('withTenantTx: tenantId is required');
  }
  return await db.transaction(async (tx) => {
    // SET LOCAL — действует только в этой транзакции, безопасно для connection pool
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    return cb(tx as unknown as TenantTx);
  });
}

/**
 * withoutTenantTx — для control plane операций (login, регистрация tenant'а).
 * Очищает app.current_tenant_id чтобы политики subscriptions работали правильно
 * (там USING (... OR current_tenant_id() IS NULL) для control plane).
 */
export async function withoutTenantTx<T>(db: Db, cb: (tx: TenantTx) => Promise<T>): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', '', true)`);
    return cb(tx as unknown as TenantTx);
  });
}
