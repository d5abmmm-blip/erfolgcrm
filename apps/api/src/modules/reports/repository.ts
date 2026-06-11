/**
 * Отчёты (перенос из v1 project_2 reportsRouter, Phase 98 — SQL-агрегаты).
 *
 * Периодные аналитические отчёты поверх существующих таблиц (своей таблицы нет):
 *   1. revenueByClient      — выручка/оплата по клиентам (tickets + work_orders);
 *   2. engineerPerformance  — нагрузка и выручка по инженерам;
 *   3. slaCompliance        — доля закрытых в срок SLA (по приоритетам);
 *   4. leadsFunnel          — воронка лидов за период;
 *   5. receivables          — дебиторка по счетам (без периода — текущее состояние).
 *
 * Деньги: суммы work_orders/invoices — копейки (string в DTO, паттерн dashboard);
 * leads.estimated_value — РУБЛИ numeric(14,2) (см. schema/leads.ts) → number в DTO.
 * Все запросы под withTenantTx (RLS).
 */
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  clients,
  invoices,
  leads,
  tickets,
  users,
  withTenantTx,
  workOrders,
  type Db,
} from '@erfolg/db';
import type { LeadStatus, TicketPriority } from '@erfolg/shared';

export interface Period {
  /** YYYY-MM-DD, включительно. */
  from?: string;
  /** YYYY-MM-DD, включительно. */
  to?: string;
}

function ticketPeriodFilters(period: Period): SQL[] {
  const parts: SQL[] = [];
  if (period.from) parts.push(gte(sql`${tickets.createdAt}::date`, period.from));
  if (period.to) parts.push(lte(sql`${tickets.createdAt}::date`, period.to));
  return parts;
}

/* ───────────────────────── 1. Выручка по клиентам ───────────────────────── */

export interface RevenueByClientRow {
  clientId: string | null;
  clientDisplayName: string;
  ticketsCount: number;
  closedCount: number;
  totalAmountKopecks: string;
  paidAmountKopecks: string;
}

export async function revenueByClient(
  db: Db,
  tenantId: string,
  period: Period,
): Promise<RevenueByClientRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        clientId: clients.id,
        clientDisplayName: sql<string>`COALESCE(${clients.displayName}, '—')`,
        ticketsCount: sql<number>`COUNT(DISTINCT ${tickets.id})::int`,
        closedCount: sql<number>`COUNT(DISTINCT ${tickets.id}) FILTER (WHERE ${tickets.status} = 'closed')::int`,
        totalAmountKopecks: sql<string>`COALESCE(SUM(${workOrders.totalAmountKopecks}), 0)::bigint::text`,
        paidAmountKopecks: sql<string>`COALESCE(SUM(${workOrders.paidAmountKopecks}), 0)::bigint::text`,
      })
      .from(tickets)
      .leftJoin(clients, eq(clients.id, tickets.clientId))
      .leftJoin(workOrders, eq(workOrders.ticketId, tickets.id))
      .where(and(isNull(tickets.deletedAt), ...ticketPeriodFilters(period)))
      .groupBy(clients.id, clients.displayName)
      .orderBy(desc(sql`COALESCE(SUM(${workOrders.totalAmountKopecks}), 0)`));
    return rows;
  });
}

/* ──────────────────────── 2. Загрузка инженеров ─────────────────────────── */

export interface EngineerPerformanceRow {
  engineerId: string | null;
  engineerName: string;
  ticketsCount: number;
  closedCount: number;
  totalAmountKopecks: string;
  /** Среднее время закрытия в днях (по закрытым), 1 знак. null если закрытых нет. */
  avgCloseDays: number | null;
}

export async function engineerPerformance(
  db: Db,
  tenantId: string,
  period: Period,
): Promise<EngineerPerformanceRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        engineerId: users.id,
        engineerName: sql<string>`COALESCE(${users.fullName}, 'Не назначен')`,
        ticketsCount: sql<number>`COUNT(DISTINCT ${tickets.id})::int`,
        closedCount: sql<number>`COUNT(DISTINCT ${tickets.id}) FILTER (WHERE ${tickets.status} = 'closed')::int`,
        totalAmountKopecks: sql<string>`COALESCE(SUM(${workOrders.totalAmountKopecks}), 0)::bigint::text`,
        avgCloseDays: sql<number | null>`ROUND((AVG(EXTRACT(EPOCH FROM (${tickets.closedAt} - ${tickets.createdAt})) / 86400))::numeric, 1)::float`,
      })
      .from(tickets)
      .leftJoin(users, eq(users.id, tickets.assignedEngineerId))
      .leftJoin(workOrders, eq(workOrders.ticketId, tickets.id))
      .where(and(isNull(tickets.deletedAt), ...ticketPeriodFilters(period)))
      .groupBy(users.id, users.fullName)
      .orderBy(desc(sql`COUNT(DISTINCT ${tickets.id})`));
    return rows;
  });
}

/* ───────────────────────── 3. SLA-комплаенс ─────────────────────────────── */

export interface SlaComplianceReport {
  /** Закрытые заявки с заданным SLA за период. */
  totalTracked: number;
  onTime: number;
  late: number;
  /** Процент закрытых в срок (0–100), null если нет данных. */
  rate: number | null;
  byPriority: Array<{
    priority: TicketPriority;
    totalTracked: number;
    onTime: number;
    rate: number | null;
  }>;
}

export async function slaCompliance(
  db: Db,
  tenantId: string,
  period: Period,
): Promise<SlaComplianceReport> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        priority: tickets.priority,
        totalTracked: sql<number>`COUNT(*)::int`,
        onTime: sql<number>`COUNT(*) FILTER (WHERE ${tickets.closedAt} <= ${tickets.slaTargetAt})::int`,
      })
      .from(tickets)
      .where(
        and(
          isNull(tickets.deletedAt),
          eq(tickets.status, 'closed'),
          sql`${tickets.slaTargetAt} IS NOT NULL`,
          ...ticketPeriodFilters(period),
        ),
      )
      .groupBy(tickets.priority);

    const totalTracked = rows.reduce((s, r) => s + r.totalTracked, 0);
    const onTime = rows.reduce((s, r) => s + r.onTime, 0);
    return {
      totalTracked,
      onTime,
      late: totalTracked - onTime,
      rate: totalTracked === 0 ? null : Math.round((onTime / totalTracked) * 100),
      byPriority: rows.map((r) => ({
        priority: r.priority,
        totalTracked: r.totalTracked,
        onTime: r.onTime,
        rate: r.totalTracked === 0 ? null : Math.round((r.onTime / r.totalTracked) * 100),
      })),
    };
  });
}

/* ───────────────────────── 4. Воронка лидов ─────────────────────────────── */

export interface LeadsFunnelReport {
  byStatus: Array<{ status: LeadStatus; count: number; valueRub: number }>;
  total: number;
  won: number;
  lost: number;
  /** Конверсия won / (всё кроме new), 0–100. null если нет обработанных. */
  conversion: number | null;
  totalPotentialRub: number;
  wonRevenueRub: number;
}

export async function leadsFunnel(
  db: Db,
  tenantId: string,
  period: Period,
): Promise<LeadsFunnelReport> {
  return withTenantTx(db, tenantId, async (tx) => {
    const parts: SQL[] = [isNull(leads.deletedAt)];
    if (period.from) parts.push(gte(sql`${leads.createdAt}::date`, period.from));
    if (period.to) parts.push(lte(sql`${leads.createdAt}::date`, period.to));

    const rows = await tx
      .select({
        status: leads.status,
        count: sql<number>`COUNT(*)::int`,
        valueRub: sql<number>`COALESCE(SUM(${leads.estimatedValue}), 0)::float`,
      })
      .from(leads)
      .where(and(...parts))
      .groupBy(leads.status);

    const get = (s: LeadStatus) => rows.find((r) => r.status === s);
    const total = rows.reduce((s, r) => s + r.count, 0);
    const won = get('won')?.count ?? 0;
    const lost = get('lost')?.count ?? 0;
    const processed = total - (get('new')?.count ?? 0);
    const totalPotentialRub = rows
      .filter((r) => r.status !== 'lost')
      .reduce((s, r) => s + r.valueRub, 0);

    return {
      byStatus: rows,
      total,
      won,
      lost,
      conversion: processed === 0 ? null : Math.round((won / processed) * 100),
      totalPotentialRub,
      wonRevenueRub: get('won')?.valueRub ?? 0,
    };
  });
}

/* ───────────────────────── 5. Дебиторка ─────────────────────────────────── */

export interface ReceivableRow {
  invoiceId: string;
  invoiceNumber: string;
  clientId: string | null;
  clientDisplayName: string;
  status: 'issued' | 'partially_paid' | 'overdue';
  dueDate: string;
  totalAmountKopecks: string;
  paidAmountKopecks: string;
  remainingKopecks: string;
  /** Дней просрочки (0 если срок не наступил). */
  overdueDays: number;
}

export interface ReceivablesReport {
  items: ReceivableRow[];
  totalRemainingKopecks: string;
  overdueRemainingKopecks: string;
}

export async function receivables(db: Db, tenantId: string): Promise<ReceivablesReport> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        clientId: clients.id,
        clientDisplayName: sql<string>`COALESCE(${clients.displayName}, '—')`,
        status: invoices.status,
        dueDate: invoices.dueDate,
        totalAmountKopecks: sql<string>`${invoices.totalAmountKopecks}::text`,
        paidAmountKopecks: sql<string>`${invoices.paidAmountKopecks}::text`,
        remainingKopecks: sql<string>`(${invoices.totalAmountKopecks} - ${invoices.paidAmountKopecks})::text`,
        overdueDays: sql<number>`GREATEST(0, (CURRENT_DATE - ${invoices.dueDate}))::int`,
      })
      .from(invoices)
      .leftJoin(clients, eq(clients.id, invoices.clientId))
      .where(
        and(
          isNull(invoices.deletedAt),
          sql`${invoices.status} IN ('issued', 'partially_paid', 'overdue')`,
        ),
      )
      .orderBy(desc(sql`(${invoices.totalAmountKopecks} - ${invoices.paidAmountKopecks})`));

    let totalRemaining = 0n;
    let overdueRemaining = 0n;
    for (const r of rows) {
      const rem = BigInt(r.remainingKopecks);
      totalRemaining += rem;
      if (r.status === 'overdue' || r.overdueDays > 0) overdueRemaining += rem;
    }

    return {
      items: rows as ReceivableRow[],
      totalRemainingKopecks: totalRemaining.toString(),
      overdueRemainingKopecks: overdueRemaining.toString(),
    };
  });
}
