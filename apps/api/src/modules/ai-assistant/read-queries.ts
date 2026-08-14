/**
 * READ-запросы AI-ассистента «спроси у системы» (только чтение, никаких мутаций).
 *
 * Зачем отдельный файл: инструменты get_finance_summary / list_aged_tickets /
 * get_tickets_stats отвечают на бизнес-вопросы директора цифрой + источником.
 * Финансовые агрегаты ПЕРЕИСПОЛЬЗУЮТ готовые функции модуля cash (repository) —
 * мы НЕ дублируем SQL кассы и НЕ редактируем сам модуль. Для заявок в модуле
 * tickets нет готового запроса «давно без активности», поэтому такой read-only
 * SQL живёт здесь (читаем таблицы tickets/ticket_events через withTenantTx; RLS
 * по tenant соблюдается автоматически).
 *
 * Все суммы — копейки (bigint → string в DTO), как в кассе.
 */
import { sql } from 'drizzle-orm';
import { withTenantTx, type Db } from '@erfolg/db';
import type { ResolvedTenant } from '../../lib/tenant';
import * as cashRepo from '../cash/repository';
import { resolvePeriod, type PeriodPreset } from '../cash/service';

/* ─────────────────────────── Период ──────────────────────────── */

export type FinancePeriod = PeriodPreset | 'prev_month';

/**
 * Период для финансовой сводки. Стандартные пресеты делегируем cash.resolvePeriod
 * (единый источник правды о границах). Добавляем 'prev_month' — прошлый календарный
 * месяц целиком [1-е прошлого, 1-е текущего).
 */
export function resolveFinancePeriod(period: FinancePeriod): {
  range: cashRepo.PeriodInput;
  label: string;
} {
  if (period === 'prev_month') {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { range: { start, end }, label: 'прошлый месяц' };
  }
  const labels: Record<PeriodPreset, string> = {
    today: 'сегодня',
    week: 'последние 7 дней',
    month: 'текущий месяц',
    quarter: 'текущий квартал',
    year: 'текущий год',
  };
  return { range: resolvePeriod(period), label: labels[period] };
}

/* ───────────────────── get_finance_summary ────────────────────── */

export interface FinanceSummaryResult {
  period: { preset: FinancePeriod; label: string; from: string; to: string };
  incomeKopecks: string;
  expenseKopecks: string;
  profitKopecks: string;
  /** Приход за период по способу денег (для ответа «сколько собрали наличными/картой/безналом»). */
  incomeByMethod: { cashKopecks: string; cardKopecks: string; bankKopecks: string };
  /** Текущие остатки по всем счетам (всего / наличные / безнал) — на момент запроса. */
  balances: { totalKopecks: string; cashKopecks: string; nonCashKopecks: string };
}

/**
 * Приход/расход/разница за период + разбивка прихода по виду денег + текущие остатки.
 * Переиспользует cashRepo.getPeriodSummary и cashRepo.getAccountBalances.
 */
export async function getFinanceSummary(
  db: Db,
  tenant: ResolvedTenant,
  period: FinancePeriod,
): Promise<FinanceSummaryResult> {
  const { range, label } = resolveFinancePeriod(period);
  const [summary, balances] = await Promise.all([
    cashRepo.getPeriodSummary(db, tenant.id, range),
    cashRepo.getAccountBalances(db, tenant.id),
  ]);
  return {
    period: {
      preset: period,
      label,
      from: range.start.toISOString().slice(0, 10),
      // end эксклюзивен — показываем последний включённый день для человекочитаемости.
      to: new Date(range.end.getTime() - 86_400_000).toISOString().slice(0, 10),
    },
    incomeKopecks: summary.incomeKopecks,
    expenseKopecks: summary.expenseKopecks,
    profitKopecks: summary.profitKopecks,
    incomeByMethod: {
      cashKopecks: summary.incomeByKind.cashKopecks,
      cardKopecks: summary.incomeByKind.cardKopecks,
      bankKopecks: summary.incomeByKind.bankKopecks,
    },
    balances: {
      totalKopecks: balances.totalKopecks,
      cashKopecks: balances.cashKopecks,
      nonCashKopecks: balances.nonCashKopecks,
    },
  };
}

/* ───────────────────── list_aged_tickets ──────────────────────── */

/** Открытые статусы = всё, кроме закрытых/отменённых. */
const OPEN_STATUSES_SQL = sql`('received','diagnostics','estimate','approval','in_progress','act_pending')`;

export interface AgedTicketRow {
  ticketNumber: string;
  clientName: string;
  status: string;
  /** Полных суток без активности (max(received_at, последнее событие)). */
  idleDays: number;
}

export interface AgedTicketsResult {
  thresholdDays: number;
  count: number;
  /** До 20 самых «застоявшихся» заявок (по убыванию простоя). */
  items: AgedTicketRow[];
  /**
   * Незакрытые заявки, перенесённые из старой программы: в список простоя они не
   * идут (иначе заняли бы его целиком), но ассистент обязан о них сказать — иначе
   * его ответ разойдётся с разделом «Сотрудники», где они посчитаны.
   */
  legacyCount: number;
}

/**
 * Открытые заявки без активности дольше N дней. «Активность» = max(received_at,
 * последнее ticket_event.created_at). Сортировка — самые застоявшиеся сверху.
 * Читает tickets/ticket_events напрямую (read-only), модуль tickets не редактируем.
 */
export async function listAgedTickets(
  db: Db,
  tenant: ResolvedTenant,
  days: number,
): Promise<AgedTicketsResult> {
  const threshold = Math.max(1, Math.floor(days));
  return withTenantTx(db, tenant.id, async (tx) => {
    const rows = (await tx.execute(sql`
      WITH last_activity AS (
        SELECT t.id,
               t.ticket_number,
               t.status,
               cl.display_name AS client_name,
               GREATEST(
                 t.received_at,
                 COALESCE((
                   SELECT MAX(te.created_at)
                   FROM ticket_events te
                   WHERE te.ticket_id = t.id
                 ), t.received_at)
               ) AS last_at
        FROM tickets t
        LEFT JOIN clients cl ON cl.id = t.client_id
        WHERE t.status IN ${OPEN_STATUSES_SQL}
          AND t.deleted_at IS NULL
          -- Заявки прежней программы мимо: их 58 незакрытых, самая старая «в работе»
          -- с февраля 2015 года, и при любом пороге они заняли бы весь ответ.
          -- Не молчим о них — считаем отдельным числом ниже.
          AND substring(t.id::text, 15, 1) <> '5'
      )
      SELECT ticket_number AS "ticketNumber",
             COALESCE(client_name, '') AS "clientName",
             status AS "status",
             FLOOR(EXTRACT(EPOCH FROM (now() - last_at)) / 86400)::int AS "idleDays"
      FROM last_activity
      WHERE last_at < now() - make_interval(days => ${threshold}::int)
      ORDER BY last_at ASC
    `)) as unknown as AgedTicketRow[];

    const legacyRows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt
        FROM tickets t
       WHERE t.status IN ${OPEN_STATUSES_SQL}
         AND t.deleted_at IS NULL
         AND substring(t.id::text, 15, 1) = '5'
    `)) as unknown as Array<{ cnt: number }>;

    return {
      thresholdDays: threshold,
      count: rows.length,
      items: rows.slice(0, 20),
      legacyCount: legacyRows[0]?.cnt ?? 0,
    };
  });
}

/* ───────────────────── get_tickets_stats ──────────────────────── */

export interface TicketsStatsResult {
  period: { preset: FinancePeriod; label: string; from: string; to: string };
  total: number;
  /** Счётчики заявок по статусу (только ненулевые), по убыванию количества. */
  byStatus: Array<{ status: string; count: number }>;
}

/**
 * Счётчики заявок по статусам за период (по дате регистрации received_at).
 * Read-only агрегат прямо по таблице tickets.
 */
export async function getTicketsStats(
  db: Db,
  tenant: ResolvedTenant,
  period: FinancePeriod,
): Promise<TicketsStatsResult> {
  const { range, label } = resolveFinancePeriod(period);
  const from = range.start.toISOString().slice(0, 10);
  const toExcl = range.end.toISOString().slice(0, 10);
  // received_at — timestamptz; бакетим его в день по таймзоне тенанта (как calendar),
  // иначе границы периода зависели бы от таймзоны сессии БД (дефолт тенанта Europe/Moscow).
  const tz = tenant.timezone;
  return withTenantTx(db, tenant.id, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT status AS "status", COUNT(*)::int AS "count"
      FROM tickets
      WHERE deleted_at IS NULL
        AND (received_at AT TIME ZONE ${tz})::date >= ${from}::date
        AND (received_at AT TIME ZONE ${tz})::date <  ${toExcl}::date
      GROUP BY status
      ORDER BY COUNT(*) DESC
    `)) as unknown as Array<{ status: string; count: number }>;
    const total = rows.reduce((s, r) => s + r.count, 0);
    return {
      period: {
        preset: period,
        label,
        from,
        to: new Date(range.end.getTime() - 86_400_000).toISOString().slice(0, 10),
      },
      total,
      byStatus: rows,
    };
  });
}
