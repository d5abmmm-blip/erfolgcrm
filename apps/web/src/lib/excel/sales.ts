/**
 * Excel-выгрузка аналитики продаж: Итоги (KPI) + По месяцам + Топ клиентов + Топ товаров.
 * Кухня общая — см. lib/excel/shared.ts (шапка, авто-ширина, формат денег).
 */
import {
  downloadWorkbook,
  getExcelJS,
  kopecksToRub,
  makeKpiSheet,
  makeTableSheet,
  MONEY_FMT,
} from './shared';
import { monthLabel } from '../cash-format';

export interface SalesAnalyticsData {
  summary: {
    revenueKopecks: string;
    costKopecks: string;
    profitKopecks: string;
    salesCount: number;
    avgCheckKopecks: string;
    marginPercent: number | null;
    unpaidKopecks: string;
    unpaidCount: number;
  };
  byMonth: Array<{
    month: string;
    revenueKopecks: string;
    costKopecks: string;
    profitKopecks: string;
    salesCount: number;
  }>;
  topClients: Array<{
    clientName: string;
    revenueKopecks: string;
    profitKopecks: string;
    salesCount: number;
  }>;
  topProducts: Array<{
    name: string;
    revenueKopecks: string;
    profitKopecks: string;
    quantity: number;
  }>;
}

/** 'YYYY-MM' → 'июн 2026'. */
function monthFull(ym: string): string {
  return `${monthLabel(ym)} ${ym.slice(0, 4)}`;
}

export async function downloadSalesAnalyticsXlsx(
  a: SalesAnalyticsData,
  periodLabel: string,
  filename: string,
): Promise<void> {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ErfolgCRM';
  wb.created = new Date();

  makeKpiSheet(wb, 'Итоги', [
    ['Период', periodLabel],
    ['Выручка', kopecksToRub(a.summary.revenueKopecks), true],
    ['Затраты (закупка)', kopecksToRub(a.summary.costKopecks), true],
    ['Прибыль', kopecksToRub(a.summary.profitKopecks), true],
    ['Маржа, %', a.summary.marginPercent ?? 0],
    ['Продаж', a.summary.salesCount],
    ['Средний чек', kopecksToRub(a.summary.avgCheckKopecks), true],
    ['Не оплачено', kopecksToRub(a.summary.unpaidKopecks), true],
    ['Не оплачено, шт', a.summary.unpaidCount],
  ]);

  makeTableSheet(
    wb,
    'По месяцам',
    [
      { header: 'Месяц', key: 'month', width: 14 },
      { header: 'Выручка', key: 'revenue', numFmt: MONEY_FMT },
      { header: 'Затраты', key: 'cost', numFmt: MONEY_FMT },
      { header: 'Прибыль', key: 'profit', numFmt: MONEY_FMT },
      { header: 'Продаж', key: 'count' },
    ],
    a.byMonth.map((m) => ({
      month: monthFull(m.month),
      revenue: kopecksToRub(m.revenueKopecks),
      cost: kopecksToRub(m.costKopecks),
      profit: kopecksToRub(m.profitKopecks),
      count: m.salesCount,
    })),
    'Нет продаж за период',
  );

  makeTableSheet(
    wb,
    'Топ клиентов',
    [
      { header: 'Клиент', key: 'client', width: 32 },
      { header: 'Выручка', key: 'revenue', numFmt: MONEY_FMT },
      { header: 'Прибыль', key: 'profit', numFmt: MONEY_FMT },
      { header: 'Продаж', key: 'count' },
    ],
    a.topClients.map((c) => ({
      client: c.clientName,
      revenue: kopecksToRub(c.revenueKopecks),
      profit: kopecksToRub(c.profitKopecks),
      count: c.salesCount,
    })),
    'Нет продаж за период',
  );

  makeTableSheet(
    wb,
    'Топ товаров',
    [
      { header: 'Позиция', key: 'name', width: 32 },
      { header: 'Выручка', key: 'revenue', numFmt: MONEY_FMT },
      { header: 'Прибыль', key: 'profit', numFmt: MONEY_FMT },
      { header: 'Кол-во', key: 'qty' },
    ],
    a.topProducts.map((p) => ({
      name: p.name,
      revenue: kopecksToRub(p.revenueKopecks),
      profit: kopecksToRub(p.profitKopecks),
      qty: p.quantity,
    })),
    'Нет продаж за период',
  );

  await downloadWorkbook(wb, filename);
}
