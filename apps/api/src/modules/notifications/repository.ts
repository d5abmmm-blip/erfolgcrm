/**
 * Repository для push_subscriptions.
 * tenant-scoped через withTenantTx; endpoint уникален глобально.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { pushSubscriptions, withTenantTx, type Db } from '@erfolg/db';

export interface PushSubscriptionDto {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
}

function toDto(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionDto {
  return {
    id: row.id,
    userId: row.userId,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.userAgent,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

export interface UpsertSubscriptionInput {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

/** Если подписка с таким endpoint уже есть — обновляем привязку (например, юзер сменился). */
export async function upsertSubscription(
  db: Db,
  tenantId: string,
  input: UpsertSubscriptionInput,
): Promise<PushSubscriptionDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(pushSubscriptions)
      .values({
        tenantId,
        userId: input.userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          tenantId,
          userId: input.userId,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent,
          lastSeenAt: sql`now()`,
          revokedAt: null,
        },
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('upsertSubscription: nothing returned');
    return toDto(row);
  });
}

/** Удалить подписку текущего юзера по endpoint (logout / unsubscribe). */
export async function deleteByEndpoint(
  db: Db,
  tenantId: string,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const r = await tx
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
      .returning({ id: pushSubscriptions.id });
    return r.length > 0;
  });
}

/** Активные подписки одного юзера. */
export async function listActiveForUser(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<PushSubscriptionDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)));
    return rows.map(toDto);
  });
}

/** Помечаем подписку отозванной (после 410 Gone). */
export async function markRevoked(
  db: Db,
  tenantId: string,
  endpoint: string,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(pushSubscriptions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(pushSubscriptions.endpoint, endpoint), isNull(pushSubscriptions.revokedAt)));
  });
}

/** Обновить lastSeenAt чтобы отслеживать, какие подписки давно не подавали признаков жизни. */
export async function touchLastSeen(
  db: Db,
  tenantId: string,
  endpoint: string,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(pushSubscriptions)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(pushSubscriptions.endpoint, endpoint));
  });
}
