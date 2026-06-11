/**
 * Audit log repository.
 *
 * Только чтение — записи делаются через `lib/audit.ts` (writeAudit).
 * Доступ — только директор (см. router).
 *
 * Хранятся 5 лет (152-ФЗ + бухучёт). На UI отдаём пагинированный список с фильтрами:
 *   - action (create/update/delete/login/...)
 *   - entityType (ticket/work_order/user/...)
 *   - userId (кто сделал)
 *   - period from/to
 *   - search (по entityId / userAgent / IP)
 *
 * Все запросы — через withTenantTx (audit_logs тоже под RLS).
 */
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { auditLogs, users, withTenantTx, type Db } from '@erfolg/db';

export type AuditAction =
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
  | 'consent_revoked';

export interface AuditRow {
  id: string;
  ts: Date;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  before: unknown;
  after: unknown;
  context: unknown;
  ip: string | null;
  userAgent: string | null;
}

export interface ListAuditOpts {
  actions?: AuditAction[];
  entityTypes?: string[];
  userId?: string | null;
  /** ISO 'YYYY-MM-DD' включительно. */
  dateFrom?: string;
  /** ISO 'YYYY-MM-DD' включительно. */
  dateTo?: string;
  /** Поиск по entityId / ip / userAgent. */
  search?: string;
  limit?: number;
  /** Курсор: ts события + id, чтобы пагинация была устойчива при равных ts. */
  cursor?: { ts: string; id: string };
}

export interface ListAuditResult {
  rows: AuditRow[];
  nextCursor: { ts: string; id: string } | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listAuditLogs(
  db: Db,
  tenantId: string,
  opts: ListAuditOpts = {},
): Promise<ListAuditResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  return withTenantTx(db, tenantId, async (tx) => {
    const conds = [];
    if (opts.actions && opts.actions.length > 0) {
      conds.push(inArray(auditLogs.action, opts.actions));
    }
    if (opts.entityTypes && opts.entityTypes.length > 0) {
      conds.push(inArray(auditLogs.entityType, opts.entityTypes));
    }
    if (opts.userId) {
      conds.push(eq(auditLogs.userId, opts.userId));
    }
    if (opts.dateFrom) {
      conds.push(gte(auditLogs.ts, new Date(`${opts.dateFrom}T00:00:00Z`)));
    }
    if (opts.dateTo) {
      // включительно: до конца дня UTC
      conds.push(lte(auditLogs.ts, new Date(`${opts.dateTo}T23:59:59.999Z`)));
    }
    if (opts.search && opts.search.trim().length > 0) {
      const q = `%${opts.search.trim()}%`;
      const searchCond = or(
        ilike(auditLogs.entityId, q),
        ilike(auditLogs.ip, q),
        ilike(auditLogs.userAgent, q),
      );
      if (searchCond) conds.push(searchCond);
    }
    if (opts.cursor) {
      // (ts, id) < (cursor.ts, cursor.id) — keyset pagination DESC.
      // Драйверу postgres-js плохо живётся с raw row constructors, поэтому
      // раскладываем на ts < cur OR (ts = cur AND id < cur.id).
      const curTs = new Date(opts.cursor.ts);
      const cursorCond = or(
        lt(auditLogs.ts, curTs),
        and(eq(auditLogs.ts, curTs), lt(auditLogs.id, opts.cursor.id)),
      );
      if (cursorCond) conds.push(cursorCond);
    }

    const rows = await tx
      .select({
        id: auditLogs.id,
        ts: auditLogs.ts,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        userId: auditLogs.userId,
        userName: users.fullName,
        userRole: users.role,
        before: auditLogs.before,
        after: auditLogs.after,
        context: auditLogs.context,
        ip: auditLogs.ip,
        userAgent: auditLogs.userAgent,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(auditLogs.ts), desc(auditLogs.id))
      .limit(limit + 1);

    let nextCursor: ListAuditResult['nextCursor'] = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      if (last) {
        nextCursor = { ts: last.ts.toISOString(), id: last.id };
      }
      rows.length = limit;
    }

    return {
      rows: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        action: r.action as AuditAction,
        entityType: r.entityType,
        entityId: r.entityId,
        userId: r.userId,
        userName: r.userName,
        userRole: r.userRole,
        before: r.before,
        after: r.after,
        context: r.context,
        ip: r.ip,
        userAgent: r.userAgent,
      })),
      nextCursor,
    };
  });
}

/** Уникальные entity_type'ы — для выпадающего фильтра. */
export async function listEntityTypes(db: Db, tenantId: string): Promise<string[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .selectDistinct({ entityType: auditLogs.entityType })
      .from(auditLogs)
      .orderBy(auditLogs.entityType);
    return rows.map((r) => r.entityType);
  });
}

/**
 * Сводная статистика для дашборда: сколько событий за последние 24 часа / 7 дней,
 * сколько уникальных пользователей, сколько неуспешных логинов за 24 часа.
 */
export interface AuditStats {
  last24hCount: number;
  last7dCount: number;
  failedLoginsLast24h: number;
}

export async function getAuditStats(db: Db, tenantId: string): Promise<AuditStats> {
  return withTenantTx(db, tenantId, async (tx) => {
    const now = new Date();
    const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [d24] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(gte(auditLogs.ts, day));
    const [d7] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(gte(auditLogs.ts, week));
    const [failed] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(and(gte(auditLogs.ts, day), eq(auditLogs.action, 'login_failed')));

    return {
      last24hCount: Number(d24?.c ?? 0),
      last7dCount: Number(d7?.c ?? 0),
      failedLoginsLast24h: Number(failed?.c ?? 0),
    };
  });
}
