/**
 * Repository для onec_exchange_log + onec_configs.
 *
 * Использует withTenantTx (RLS). Логи append-only — никаких update'ов после completion.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { onecConfigs, onecExchangeLog, withTenantTx, type Db } from '@erfolg/db';
import type { OnecExchangePayload, OnecExchangeResult } from '@erfolg/db';

export interface ExchangeLogDto {
  id: string;
  direction: 'export' | 'import';
  kind: string;
  status: 'pending' | 'success' | 'failed' | 'partial';
  payload: OnecExchangePayload | null;
  result: OnecExchangeResult | null;
  errorMessage: string | null;
  processedCount: number;
  errorCount: number;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

function toDto(row: typeof onecExchangeLog.$inferSelect): ExchangeLogDto {
  return {
    id: row.id,
    direction: row.direction,
    kind: row.kind,
    status: row.status,
    payload: row.payload,
    result: row.result,
    errorMessage: row.errorMessage,
    processedCount: row.processedCount,
    errorCount: row.errorCount,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}

export async function startExchange(
  db: Db,
  tenantId: string,
  input: {
    direction: 'export' | 'import';
    kind: string;
    payload?: OnecExchangePayload | null;
  },
): Promise<ExchangeLogDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(onecExchangeLog)
      .values({
        tenantId,
        direction: input.direction,
        kind: input.kind,
        status: 'pending',
        payload: input.payload ?? null,
      })
      .returning();
    if (!inserted[0]) throw new Error('startExchange: insert returned nothing');
    return toDto(inserted[0]);
  });
}

export async function completeExchange(
  db: Db,
  tenantId: string,
  exchangeId: string,
  outcome: {
    status: 'success' | 'failed' | 'partial';
    result?: OnecExchangeResult | null;
    errorMessage?: string | null;
    processedCount?: number;
    errorCount?: number;
  },
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(onecExchangeLog)
      .set({
        status: outcome.status,
        result: outcome.result ?? null,
        errorMessage: outcome.errorMessage ?? null,
        processedCount: outcome.processedCount ?? 0,
        errorCount: outcome.errorCount ?? 0,
        completedAt: sql`now()`,
      })
      .where(eq(onecExchangeLog.id, exchangeId));
  });
}

export async function listRecentExchanges(
  db: Db,
  tenantId: string,
  limit = 50,
): Promise<ExchangeLogDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(onecExchangeLog)
      .orderBy(desc(onecExchangeLog.startedAt))
      .limit(limit);
    return rows.map(toDto);
  });
}

export interface OnecConfigDto {
  enabled: boolean;
  hasIncomingToken: boolean;
  exportTimezone: string | null;
  updatedAt: Date;
}

export async function getConfig(db: Db, tenantId: string): Promise<OnecConfigDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(onecConfigs)
      .where(eq(onecConfigs.tenantId, tenantId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      enabled: row.enabled,
      hasIncomingToken: row.incomingTokenHash !== null,
      exportTimezone: row.exportTimezone,
      updatedAt: row.updatedAt,
    };
  });
}

export async function upsertConfig(
  db: Db,
  tenantId: string,
  input: { enabled?: boolean; exportTimezone?: string | null },
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .insert(onecConfigs)
      .values({
        tenantId,
        enabled: input.enabled ?? false,
        exportTimezone: input.exportTimezone ?? null,
      })
      .onConflictDoUpdate({
        target: onecConfigs.tenantId,
        set: {
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.exportTimezone !== undefined ? { exportTimezone: input.exportTimezone } : {}),
        },
      });
  });
}

export async function setIncomingTokenHash(
  db: Db,
  tenantId: string,
  hash: string | null,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .insert(onecConfigs)
      .values({ tenantId, incomingTokenHash: hash, enabled: true })
      .onConflictDoUpdate({
        target: onecConfigs.tenantId,
        set: { incomingTokenHash: hash },
      });
  });
}

/**
 * Возвращает stored hash (для верификации входящего токена в webhook).
 * Использует raw db — webhook не имеет tenant-context до резолва.
 * Безопасность: token hash возвращается только если он есть и enabled=true.
 */
export async function findEnabledTokenHashByTenant(
  db: Db,
  tenantId: string,
): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ hash: onecConfigs.incomingTokenHash, enabled: onecConfigs.enabled })
      .from(onecConfigs)
      .where(and(eq(onecConfigs.tenantId, tenantId), eq(onecConfigs.enabled, true)))
      .limit(1);
    return rows[0]?.hash ?? null;
  });
}
