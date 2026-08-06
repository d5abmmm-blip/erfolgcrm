/**
 * Сервис dashboard — тонкая обёртка над repository.
 * Здесь нет бизнес-логики — только маршрутизация и нормализация input'а.
 */
import type { Db } from '@erfolg/db';
import * as repo from './repository';

export interface PeriodPreset {
  preset: 'today' | 'week' | 'month' | 'quarter' | 'custom';
  /** Для custom — обязательны start/end ISO. */
  start?: string;
  end?: string;
}

/**
 * Нормализует пресет периода в [start,end) UTC.
 * Границы считаются по UTC чтобы не зависеть от tz сервера.
 * Фронт может прислать custom со своими границами.
 */
export function resolvePeriod(input: PeriodPreset): repo.PeriodInput {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrow = new Date(startOfDay);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  switch (input.preset) {
    case 'today':
      return { start: startOfDay, end: tomorrow };
    case 'week': {
      // 7 дней назад до конца сегодня
      const start = new Date(startOfDay);
      start.setUTCDate(start.getUTCDate() - 6);
      return { start, end: tomorrow };
    }
    case 'month': {
      // С 1 числа текущего месяца
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { start, end: tomorrow };
    }
    case 'quarter': {
      // С 1 числа текущего квартала
      const q = Math.floor(now.getUTCMonth() / 3);
      const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
      return { start, end: tomorrow };
    }
    case 'custom': {
      if (!input.start || !input.end) {
        throw new Error('resolvePeriod: для custom нужны start и end');
      }
      const s = new Date(input.start);
      const e = new Date(input.end);
      if (Number.isNaN(s.valueOf()) || Number.isNaN(e.valueOf())) {
        throw new Error('resolvePeriod: некорректные даты');
      }
      if (e <= s) throw new Error('resolvePeriod: end должен быть > start');
      return { start: s, end: e };
    }
  }
}

export async function getMetricsCmd(
  db: Db,
  tenantId: string,
  input: PeriodPreset,
): Promise<repo.DashboardMetrics & { period: { start: string; end: string } }> {
  const period = resolvePeriod(input);
  const metrics = await repo.getMetrics(db, tenantId, period);
  return {
    ...metrics,
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
  };
}

export async function listOverdueInvoicesQuery(db: Db, tenantId: string, limit?: number) {
  return repo.listOverdueInvoices(db, tenantId, limit);
}

export async function listSlaAtRiskQuery(db: Db, tenantId: string, limit?: number) {
  return repo.listSlaAtRisk(db, tenantId, limit);
}

export async function listLowStockQuery(db: Db, tenantId: string, limit?: number) {
  return repo.listLowStock(db, tenantId, limit);
}

export async function listMaintenanceForTodayQuery(
  db: Db,
  tenantId: string,
  includeOverdue: boolean,
  limit?: number,
) {
  return repo.listMaintenanceForToday(db, tenantId, includeOverdue, limit);
}

export async function getNavBadgesQuery(
  db: Db,
  tenantId: string,
  role: 'director' | 'dispatcher' | 'engineer',
  userId: string,
): Promise<repo.NavBadgeCounts> {
  return repo.getNavBadgeCounts(db, tenantId, role, userId);
}

export async function getDailySummaryQuery(
  db: Db,
  tenantId: string,
  dateIso: string,
): Promise<repo.DailySummaryData> {
  const date = new Date(dateIso);
  if (Number.isNaN(date.valueOf())) {
    throw new Error('getDailySummary: некорректная дата');
  }
  return repo.getDailySummary(db, tenantId, date);
}
