/**
 * Этап 9.A — Dashboard агрегации (директор).
 *
 * Все запросы — read-only, идут через withTenantTx (RLS-защита).
 * Денежные суммы — bigint в копейках, сериализуются через .toString() для superjson.
 *
 * Период для метрик передаётся как { start: Date, end: Date } в UTC.
 * Фронт сам считает границы день/неделя/месяц/квартал в localtime tenant'а.
 */
import { sql } from 'drizzle-orm';
import { withTenantTx, type Db } from '@erfolg/db';
import { exclInternalCond, internalCategoryIds } from '../cash/repository';
import {
  maintenanceDueByTodaySql,
  maintenanceDueTodaySql,
  maintenanceOverdueSql,
} from '../../lib/maintenance-due';
import { orgTodaySql } from '../../lib/org-day';

export interface PeriodInput {
  /** Включительно (UTC). */
  start: Date;
  /** Исключительно (UTC). */
  end: Date;
}

export interface DashboardMetrics {
  /** Итого оплачено за период (paid_at в [start,end)). Копейки. */
  revenuePeriodKopecks: string;
  /** Сумма total_amount за период (закрытые заявки). */
  revenueClosedPeriodKopecks: string;
  /** Сумма margin за тот же набор. */
  marginPeriodKopecks: string;
  /** Маржа в процентах (margin/revenueClosed*100). 2 знака. NULL если revenueClosed=0. */
  marginPercent: number | null;
  /** Дебиторка: SUM(total - paid) по issued+partially_paid+overdue. */
  receivablesTotalKopecks: string;
  /**
   * Незакрытые заявки, перенесённые из старой программы. Отдельным числом: в работу
   * они не входят, но и делать вид, что их нет, нельзя.
   */
  legacyActiveTicketsCount: number;
  /** Просрочка: то же по status='overdue'. */
  overdueTotalKopecks: string;
  /** Активные заявки (не closed/cancelled, не deleted). */
  activeTicketsCount: number;
  /** Заявки с SLA в зоне риска: sla_target_at < NOW + 24h, не закрытые. */
  slaAtRiskCount: number;
  /** Позиции склада с остатком ниже min_stock. */
  lowStockCount: number;
  /** Плановые ТО на сегодня (next_due_at::date = today, isActive). */
  todayMaintenanceCount: number;
  /** ТО просрочены (next_due_at < сегодня, isActive). */
  overdueMaintenanceCount: number;
}

const POSITIVE_TICKET_STATUSES = sql`('received','diagnostics','estimate','approval','in_progress','act_pending')`;
const RECEIVABLE_INVOICE_STATUSES = sql`('issued','partially_paid','overdue')`;

interface CountRow {
  cnt: number;
}
interface SumRow {
  sumv: string | null;
}

function bigIntFromSum(value: string | null): bigint {
  if (!value) return 0n;
  return BigInt(value);
}

export async function getMetrics(
  db: Db,
  tenantId: string,
  period: PeriodInput,
): Promise<DashboardMetrics> {
  return withTenantTx(db, tenantId, async (tx) => {
    const startIso = period.start.toISOString();
    const endIso = period.end.toISOString();

    // 1) Выручка за период — ПРИХОД ПО КАССЕ, ровно как «Собрано» в разделе «Финансы».
    //
    // Раньше здесь суммировались `payments`, то есть только оплаты, заведённые кнопкой
    // «Внести платёж» в заявке. В кассу же доход попадает четырьмя путями: ручная
    // операция, оплата продажи, внутреннее внесение и автосинк из payments — касса
    // всегда ШИРЕ, и плитка систематически занижала. На боевой базе оплату ведут
    // кассой, а payments пуст: директор видел 0 ₽ выручки при полной кассе.
    //
    // Переводы между счетами и внутренние статьи исключаются тем же правилом, что и
    // на /finance: это перекладывание из кармана в карман, а не выручка.
    const internalIds = await internalCategoryIds(tx, tenantId);
    const revenueRows = (await tx.execute(sql`
      SELECT COALESCE(SUM(amount_kopecks)::text, '0') AS sumv
        FROM cash_transactions
       WHERE deleted_at IS NULL
         AND kind = 'income'
         AND occurred_on >= ${startIso}::timestamptz::date
         AND occurred_on <  ${endIso}::timestamptz::date
         ${exclInternalCond(internalIds, 'category_id')}
    `)) as unknown as SumRow[];
    const revenue = bigIntFromSum(revenueRows[0]?.sumv ?? '0');

    // 2) Closed work_orders в периоде → total и margin
    const closedRows = (await tx.execute(sql`
      SELECT
        COALESCE(SUM(wo.total_amount_kopecks)::text,  '0') AS total,
        COALESCE(SUM(wo.margin_amount_kopecks)::text, '0') AS margin
        FROM work_orders wo
        JOIN tickets t ON t.id = wo.ticket_id
       WHERE t.status = 'closed'
         AND t.deleted_at IS NULL
         AND t.closed_at >= ${startIso}::timestamptz
         AND t.closed_at <  ${endIso}::timestamptz
    `)) as unknown as Array<{ total: string; margin: string }>;
    const totalClosed = bigIntFromSum(closedRows[0]?.total ?? '0');
    const marginClosed = bigIntFromSum(closedRows[0]?.margin ?? '0');
    const marginPercent =
      totalClosed > 0n
        ? Math.round((Number(marginClosed) / Number(totalClosed)) * 10000) / 100
        : null;

    // 3) Receivables и Overdue
    const recRows = (await tx.execute(sql`
      SELECT
        COALESCE(SUM(total_amount_kopecks - paid_amount_kopecks)::text, '0') AS receivable,
        COALESCE(SUM(
          CASE WHEN status = 'overdue'
               THEN total_amount_kopecks - paid_amount_kopecks
               ELSE 0
          END)::text, '0') AS overdue
        FROM invoices
       WHERE deleted_at IS NULL
         AND status IN ${RECEIVABLE_INVOICE_STATUSES}
    `)) as unknown as Array<{ receivable: string; overdue: string }>;
    const receivable = bigIntFromSum(recRows[0]?.receivable ?? '0');
    const overdue = bigIntFromSum(recRows[0]?.overdue ?? '0');

    // 4) Active tickets — считаем СВОИ и перенесённые по отдельности.
    // Незакрытых заявок из старой программы 58, 41 из них на служебном
    // «Администраторе», самая старая «в работе» с февраля 2015 года. Пока они входили
    // в общее число, директор видел «активные заявки», почти наполовину состоящие из
    // хвоста переноса. Прятать нельзя — заявки существуют; поэтому две цифры.
    const activeRows = (await tx.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE substring(id::text, 15, 1) <> '5')::int AS cnt,
        COUNT(*) FILTER (WHERE substring(id::text, 15, 1) =  '5')::int AS legacy_cnt
        FROM tickets
       WHERE deleted_at IS NULL
         AND status IN ${POSITIVE_TICKET_STATUSES}
    `)) as unknown as Array<{ cnt: number; legacy_cnt: number }>;
    const activeTickets = activeRows[0]?.cnt ?? 0;
    const legacyActiveTickets = activeRows[0]?.legacy_cnt ?? 0;

    // 5) SLA at risk: дедлайн в ближайшие 24ч (или уже просрочен), не закрытые
    const slaRows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt
        FROM tickets
       WHERE deleted_at IS NULL
         AND status IN ${POSITIVE_TICKET_STATUSES}
         AND sla_target_at IS NOT NULL
         AND sla_target_at < (now() + interval '24 hours')
    `)) as unknown as CountRow[];
    const slaAtRisk = slaRows[0]?.cnt ?? 0;

    // 6) Low stock: COALESCE(SUM(batch.qty),0) < item.min_stock
    const lowRows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt
        FROM inventory_items i
       WHERE i.deleted_at IS NULL
         AND i.min_stock > 0
         AND COALESCE((
           SELECT SUM(b.quantity_remaining)
             FROM inventory_batches b
            WHERE b.item_id = i.id
         ), 0) < i.min_stock
    `)) as unknown as CountRow[];
    const lowStock = lowRows[0]?.cnt ?? 0;

    // 7) Сегодняшние ТО + просроченные ТО
    const maintRows = (await tx.execute(sql`
      SELECT
        SUM(CASE WHEN ${maintenanceDueTodaySql(sql`next_due_at`, tenantId)} AND is_active THEN 1 ELSE 0 END)::int AS today_cnt,
        SUM(CASE WHEN ${maintenanceOverdueSql(sql`next_due_at`, tenantId)} AND is_active THEN 1 ELSE 0 END)::int AS overdue_cnt
        FROM maintenance_schedules
       WHERE deleted_at IS NULL
    `)) as unknown as Array<{ today_cnt: number | null; overdue_cnt: number | null }>;
    const todayMaintenance = maintRows[0]?.today_cnt ?? 0;
    const overdueMaintenance = maintRows[0]?.overdue_cnt ?? 0;

    return {
      revenuePeriodKopecks: revenue.toString(),
      revenueClosedPeriodKopecks: totalClosed.toString(),
      marginPeriodKopecks: marginClosed.toString(),
      marginPercent,
      receivablesTotalKopecks: receivable.toString(),
      overdueTotalKopecks: overdue.toString(),
      activeTicketsCount: activeTickets,
      legacyActiveTicketsCount: legacyActiveTickets,
      slaAtRiskCount: slaAtRisk,
      lowStockCount: lowStock,
      todayMaintenanceCount: todayMaintenance,
      overdueMaintenanceCount: overdueMaintenance,
    };
  });
}

/* ============================== NAV BADGES ============================== */

/** Счётчики «требует внимания» для бейджей бокового меню. */
export interface NavBadgeCounts {
  /** Заявки на разбор: staff — новые (received); инженер — свои, ждущие акта. */
  ticketsAttention: number;
  /** Новые лиды (status='new'). 0 для инженера. */
  leadsNew: number;
  /** События календаря на сегодня. 0 для инженера. */
  calendarToday: number;
  /** Просроченные счета (status='overdue'). 0 для инженера. */
  invoicesOverdue: number;
  /** Просроченное плановое ТО (next_due_at в прошлом, активно). */
  maintenanceOverdue: number;
  /** Позиции склада с остатком ниже минимума. */
  inventoryLowStock: number;
  /** Фича №7 — активные заявки, стоящие из-за ожидания детали. 0 для инженера. */
  partsWaiting: number;
}

/**
 * Лёгкие COUNT-запросы для бейджей навигации (все по существующим индексам).
 * Ролевые: staff (директор/диспетчер) видят весь операционный «инбокс», инженер —
 * только свои заявки на акт + операционные склад/ТО (разделы лиды/календарь/счета
 * ему в меню не видны, поэтому считаем их только для staff). Через RLS (withTenantTx).
 *
 * «Сегодня/просрочка» считаются на сервере (день организации из lib/org-day.ts / now()),
 * как в getMetrics — единый источник правды по времени, без рассинхрона с клиентом.
 */
export async function getNavBadgeCounts(
  db: Db,
  tenantId: string,
  role: 'director' | 'dispatcher' | 'engineer',
  userId: string,
): Promise<NavBadgeCounts> {
  const isStaff = role === 'director' || role === 'dispatcher';
  return withTenantTx(db, tenantId, async (tx) => {
    // Заявки: staff — новые на разбор (received); инженер — свои в act_pending.
    const ticketCond = isStaff
      ? sql`status = 'received'`
      : sql`status = 'act_pending' AND assigned_engineer_id = ${userId}`;
    const ticketRows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM tickets
       WHERE deleted_at IS NULL AND ${ticketCond}
    `)) as unknown as CountRow[];
    const ticketsAttention = ticketRows[0]?.cnt ?? 0;

    let leadsNew = 0;
    let calendarToday = 0;
    let invoicesOverdue = 0;
    let partsWaiting = 0;
    if (isStaff) {
      // Фича №7 — активные заявки, стоящие из-за ожидания детали.
      const partsRows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM tickets
         WHERE deleted_at IS NULL AND waiting_for_part = true
           AND status NOT IN ('closed', 'cancelled')
      `)) as unknown as CountRow[];
      partsWaiting = partsRows[0]?.cnt ?? 0;

      const leadRows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM leads
         WHERE deleted_at IS NULL AND status = 'new'
      `)) as unknown as CountRow[];
      leadsNew = leadRows[0]?.cnt ?? 0;

      const calRows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM calendar_events
         WHERE deleted_at IS NULL AND event_date = ${orgTodaySql(tenantId)}
      `)) as unknown as CountRow[];
      calendarToday = calRows[0]?.cnt ?? 0;

      const invRows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM invoices
         WHERE deleted_at IS NULL AND status = 'overdue'
      `)) as unknown as CountRow[];
      invoicesOverdue = invRows[0]?.cnt ?? 0;
    }

    // Склад/ТО — операционные сигналы, считаем для всех ролей.
    const maintRows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM maintenance_schedules
       WHERE deleted_at IS NULL AND is_active
         AND ${maintenanceOverdueSql(sql`next_due_at`, tenantId)}
    `)) as unknown as CountRow[];
    const maintenanceOverdue = maintRows[0]?.cnt ?? 0;

    const lowRows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM inventory_items i
       WHERE i.deleted_at IS NULL AND i.min_stock > 0
         AND COALESCE((
           SELECT SUM(b.quantity_remaining) FROM inventory_batches b WHERE b.item_id = i.id
         ), 0) < i.min_stock
    `)) as unknown as CountRow[];
    const inventoryLowStock = lowRows[0]?.cnt ?? 0;

    return {
      ticketsAttention,
      leadsNew,
      calendarToday,
      invoicesOverdue,
      maintenanceOverdue,
      inventoryLowStock,
      partsWaiting,
    };
  });
}

/* ============================== DRILL-DOWN ============================== */

export interface OverdueInvoiceRow {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string | null;
  totalAmountKopecks: string;
  paidAmountKopecks: string;
  remainingKopecks: string;
  dueDate: string;
  daysOverdue: number;
}

export async function listOverdueInvoices(
  db: Db,
  tenantId: string,
  limit = 100,
): Promise<OverdueInvoiceRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        i.id,
        i.invoice_number,
        i.client_id,
        c.display_name AS client_name,
        i.total_amount_kopecks::text AS total,
        i.paid_amount_kopecks::text  AS paid,
        (i.total_amount_kopecks - i.paid_amount_kopecks)::text AS remaining,
        i.due_date::text AS due_date,
        GREATEST(0, (${orgTodaySql(tenantId)} - i.due_date::date))::int AS days_overdue
        FROM invoices i
        LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.deleted_at IS NULL
         AND i.status = 'overdue'
       ORDER BY i.due_date ASC
       LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      invoice_number: string;
      client_id: string;
      client_name: string | null;
      total: string;
      paid: string;
      remaining: string;
      due_date: string;
      days_overdue: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoice_number,
      clientId: r.client_id,
      clientName: r.client_name,
      totalAmountKopecks: r.total,
      paidAmountKopecks: r.paid,
      remainingKopecks: r.remaining,
      dueDate: r.due_date,
      daysOverdue: r.days_overdue,
    }));
  });
}

export interface SlaAtRiskRow {
  id: string;
  ticketNumber: string;
  status: string;
  slaTargetAt: Date;
  hoursUntilSla: number;
  clientName: string | null;
  engineerName: string | null;
}

export async function listSlaAtRisk(
  db: Db,
  tenantId: string,
  limit = 100,
): Promise<SlaAtRiskRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        t.id,
        t.ticket_number,
        t.status::text AS status,
        t.sla_target_at,
        EXTRACT(EPOCH FROM (t.sla_target_at - now())) / 3600.0 AS hours_left,
        c.display_name AS client_name,
        u.full_name    AS engineer_name
        FROM tickets t
        LEFT JOIN clients c ON c.id = t.client_id
        LEFT JOIN users   u ON u.id = t.assigned_engineer_id
       WHERE t.deleted_at IS NULL
         AND t.status IN ${POSITIVE_TICKET_STATUSES}
         AND t.sla_target_at IS NOT NULL
         AND t.sla_target_at < (now() + interval '24 hours')
       ORDER BY t.sla_target_at ASC
       LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      ticket_number: string;
      status: string;
      sla_target_at: Date;
      hours_left: string;
      client_name: string | null;
      engineer_name: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ticketNumber: r.ticket_number,
      status: r.status,
      slaTargetAt: r.sla_target_at,
      hoursUntilSla: Math.round(Number(r.hours_left) * 10) / 10,
      clientName: r.client_name,
      engineerName: r.engineer_name,
    }));
  });
}

export interface LowStockRow {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  minStock: string;
  currentStock: string;
  deficit: string;
}

export async function listLowStock(db: Db, tenantId: string, limit = 100): Promise<LowStockRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        i.id,
        i.name,
        i.sku,
        i.unit,
        i.min_stock::text AS min_stock,
        COALESCE((
          SELECT SUM(b.quantity_remaining)
            FROM inventory_batches b
           WHERE b.item_id = i.id
        ), 0)::text AS current_stock,
        (i.min_stock - COALESCE((
          SELECT SUM(b.quantity_remaining)
            FROM inventory_batches b
           WHERE b.item_id = i.id
        ), 0))::text AS deficit
        FROM inventory_items i
       WHERE i.deleted_at IS NULL
         AND i.min_stock > 0
         AND COALESCE((
           SELECT SUM(b.quantity_remaining)
             FROM inventory_batches b
            WHERE b.item_id = i.id
         ), 0) < i.min_stock
       ORDER BY i.name ASC
       LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      name: string;
      sku: string | null;
      unit: string;
      min_stock: string;
      current_stock: string;
      deficit: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.sku,
      unit: r.unit,
      minStock: r.min_stock,
      currentStock: r.current_stock,
      deficit: r.deficit,
    }));
  });
}

export interface MaintenanceTodayRow {
  scheduleId: string;
  assetId: string;
  assetName: string;
  nextDueAt: Date;
  intervalDays: number;
  responsibleName: string | null;
  isOverdue: boolean;
}

export async function listMaintenanceForToday(
  db: Db,
  tenantId: string,
  includeOverdue = true,
  limit = 200,
): Promise<MaintenanceTodayRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const todayCondition = includeOverdue
      ? maintenanceDueByTodaySql(sql`s.next_due_at`, tenantId)
      : maintenanceDueTodaySql(sql`s.next_due_at`, tenantId);
    const rows = (await tx.execute(sql`
      SELECT
        s.id            AS schedule_id,
        s.asset_id,
        a.model         AS asset_name,
        s.next_due_at,
        s.interval_days,
        u.full_name     AS responsible_name,
        (${maintenanceOverdueSql(sql`s.next_due_at`, tenantId)}) AS is_overdue
        FROM maintenance_schedules s
        JOIN assets a ON a.id = s.asset_id
        LEFT JOIN users u ON u.id = s.responsible_user_id
       WHERE s.deleted_at IS NULL
         AND s.is_active
         AND ${todayCondition}
       ORDER BY s.next_due_at ASC
       LIMIT ${limit}
    `)) as unknown as Array<{
      schedule_id: string;
      asset_id: string;
      asset_name: string;
      next_due_at: Date;
      interval_days: number;
      responsible_name: string | null;
      is_overdue: boolean;
    }>;
    return rows.map((r) => ({
      scheduleId: r.schedule_id,
      assetId: r.asset_id,
      assetName: r.asset_name,
      nextDueAt: r.next_due_at,
      intervalDays: r.interval_days,
      responsibleName: r.responsible_name,
      isOverdue: r.is_overdue,
    }));
  });
}

/**
 * Сводка дня: всё что нужно для PDF/Excel в одном вызове.
 * Используется в 9.E.
 */
export interface DailySummaryData {
  date: string; // YYYY-MM-DD
  metrics: DashboardMetrics;
  overdueInvoices: OverdueInvoiceRow[];
  slaAtRisk: SlaAtRiskRow[];
  lowStock: LowStockRow[];
  maintenanceToday: MaintenanceTodayRow[];
  closedTicketsToday: Array<{
    id: string;
    ticketNumber: string;
    clientName: string | null;
    totalAmountKopecks: string;
  }>;
}

export async function getDailySummary(
  db: Db,
  tenantId: string,
  date: Date,
): Promise<DailySummaryData> {
  // День от 00:00 до 24:00 UTC
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const [metrics, overdueInvoices, slaAtRisk, lowStock, maintenanceToday] = await Promise.all([
    getMetrics(db, tenantId, { start, end }),
    listOverdueInvoices(db, tenantId, 50),
    listSlaAtRisk(db, tenantId, 50),
    listLowStock(db, tenantId, 50),
    listMaintenanceForToday(db, tenantId, true, 100),
  ]);

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const closedTicketsToday = await withTenantTx(db, tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        t.id,
        t.ticket_number,
        c.display_name AS client_name,
        wo.total_amount_kopecks::text AS total
        FROM tickets t
        JOIN work_orders wo ON wo.ticket_id = t.id
        LEFT JOIN clients c ON c.id = t.client_id
       WHERE t.status = 'closed'
         AND t.deleted_at IS NULL
         AND t.closed_at >= ${startIso}::timestamptz
         AND t.closed_at <  ${endIso}::timestamptz
       ORDER BY t.closed_at DESC
    `)) as unknown as Array<{
      id: string;
      ticket_number: string;
      client_name: string | null;
      total: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ticketNumber: r.ticket_number,
      clientName: r.client_name,
      totalAmountKopecks: r.total,
    }));
  });

  return {
    date: start.toISOString().slice(0, 10),
    metrics,
    overdueInvoices,
    slaAtRisk,
    lowStock,
    maintenanceToday,
    closedTicketsToday,
  };
}
