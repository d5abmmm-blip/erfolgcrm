/**
 * Excel «Аналитика за период» — по одному листу на раздел отчётов.
 * Данные приходят уже загруженными со страницы (те же запросы reports.*), builder только
 * раскладывает их по листам. Разделы, которые не загрузились (нет прав / ошибка), пропускаются.
 */
import {
  DATE_FMT,
  MONEY_FMT,
  downloadWorkbook,
  getExcelJS,
  kopecksToRub,
  makeKpiSheet,
  makeTableSheet,
} from './shared';

/* Формы данных повторяют то, что отдают процедуры reports.* (см. ReportsPage). */

export interface RevenueRow {
  clientDisplayName: string;
  ticketsCount: number;
  closedCount: number;
  totalAmountKopecks: string;
  paidAmountKopecks: string;
}
export interface EngineerRow {
  engineerName: string;
  ticketsCount: number;
  closedCount: number;
  totalAmountKopecks: string;
  avgCloseDays: number | null;
}
export interface ProfitRow {
  name: string;
  closedOrdersCount: number;
  totalAmountKopecks: string;
  costAmountKopecks: string;
  marginAmountKopecks: string;
  marginPercent: number | null;
}
export interface ProfitabilityData {
  // summary без name/ключа — это агрегат по всему периоду (форма reports.profitability).
  summary: {
    totalAmountKopecks: string;
    costAmountKopecks: string;
    marginAmountKopecks: string;
    marginPercent: number | null;
  };
  byEngineer: ProfitRow[];
  byEquipment: ProfitRow[];
}
export interface SlaData {
  totalTracked: number;
  onTime: number;
  late: number;
  rate: number | null;
  byPriority: Array<{ priority: string; totalTracked: number; onTime: number; rate: number | null }>;
}
export interface LeadsData {
  total: number;
  conversion: number | null;
  totalPotentialRub: number;
  wonRevenueRub: number;
  byStatus: Array<{ status: string; count: number; valueRub: number }>;
}
export interface ReceivableRow {
  invoiceNumber: string;
  clientDisplayName: string;
  dueDate: string;
  overdueDays: number;
  remainingKopecks: string;
}

export interface AnalyticsExportInput {
  periodLabel: string;
  periodHuman: string;
  revenue?: RevenueRow[];
  engineers?: EngineerRow[];
  profitability?: ProfitabilityData | null;
  sla?: SlaData | null;
  leads?: LeadsData | null;
  receivables?: ReceivableRow[];
}

const PRIORITY_LABEL: Record<string, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
  urgent: 'Срочный',
};
const LEAD_LABEL: Record<string, string> = {
  new: 'Новые',
  contacted: 'Контакт',
  proposal: 'КП',
  negotiation: 'Переговоры',
  won: 'Выиграны',
  lost: 'Проиграны',
};

function profitRows(rows: ProfitRow[]) {
  return rows.map((r) => ({
    name: r.name,
    closedOrdersCount: r.closedOrdersCount,
    totalRub: kopecksToRub(r.totalAmountKopecks),
    costRub: kopecksToRub(r.costAmountKopecks),
    marginRub: kopecksToRub(r.marginAmountKopecks),
    marginPercent: r.marginPercent ?? '—',
  }));
}
const PROFIT_COLS = [
  { header: 'Наименование', key: 'name' as const, width: 28 },
  { header: 'Закрыто нарядов', key: 'closedOrdersCount' as const },
  { header: 'Выручка, ₽', key: 'totalRub' as const, numFmt: MONEY_FMT },
  { header: 'Себестоимость, ₽', key: 'costRub' as const, numFmt: MONEY_FMT },
  { header: 'Маржа, ₽', key: 'marginRub' as const, numFmt: MONEY_FMT },
  { header: 'Маржа, %', key: 'marginPercent' as const },
];

export async function downloadAnalyticsXlsx(input: AnalyticsExportInput): Promise<void> {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Erfolg CRM';
  wb.created = new Date();

  makeKpiSheet(wb, 'Обзор', [['Период', input.periodHuman]]);

  if (input.revenue) {
    makeTableSheet(
      wb,
      'Выручка по клиентам',
      [
        { header: 'Клиент', key: 'client', width: 30 },
        { header: 'Заявок', key: 'tickets' },
        { header: 'Закрыто', key: 'closed' },
        { header: 'Сумма нарядов, ₽', key: 'totalRub', numFmt: MONEY_FMT },
        { header: 'Оплачено, ₽', key: 'paidRub', numFmt: MONEY_FMT },
      ],
      input.revenue.map((r) => ({
        client: r.clientDisplayName,
        tickets: r.ticketsCount,
        closed: r.closedCount,
        totalRub: kopecksToRub(r.totalAmountKopecks),
        paidRub: kopecksToRub(r.paidAmountKopecks),
      })),
      'Нет данных за период',
    );
  }

  if (input.engineers) {
    makeTableSheet(
      wb,
      'Загрузка инженеров',
      [
        { header: 'Инженер', key: 'name', width: 28 },
        { header: 'Заявок', key: 'tickets' },
        { header: 'Закрыто', key: 'closed' },
        { header: 'Выручка (наряды), ₽', key: 'revenueRub', numFmt: MONEY_FMT },
        { header: 'Ср. время закрытия, дн.', key: 'avgDays' },
      ],
      input.engineers.map((r) => ({
        name: r.engineerName,
        tickets: r.ticketsCount,
        closed: r.closedCount,
        revenueRub: kopecksToRub(r.totalAmountKopecks),
        avgDays: r.avgCloseDays ?? '—',
      })),
      'Нет данных по инженерам за период',
    );
  }

  if (input.profitability) {
    const p = input.profitability;
    makeKpiSheet(wb, 'Рентабельность (итог)', [
      ['Выручка (закрытые), ₽', kopecksToRub(p.summary.totalAmountKopecks), true],
      ['Себестоимость, ₽', kopecksToRub(p.summary.costAmountKopecks), true],
      ['Маржа (прибыль), ₽', kopecksToRub(p.summary.marginAmountKopecks), true],
      ['Маржа, %', p.summary.marginPercent ?? '—'],
    ]);
    makeTableSheet(wb, 'Рентабельность · инженеры', PROFIT_COLS, profitRows(p.byEngineer), 'Нет данных');
    makeTableSheet(wb, 'Рентабельность · техника', PROFIT_COLS, profitRows(p.byEquipment), 'Нет данных');
  }

  if (input.sla) {
    const s = input.sla;
    makeKpiSheet(wb, 'SLA (итог)', [
      ['Закрыто с SLA', s.totalTracked],
      ['В срок', s.onTime],
      ['С опозданием', s.late],
      ['Соблюдение SLA, %', s.rate ?? '—'],
    ]);
    makeTableSheet(
      wb,
      'SLA по приоритетам',
      [
        { header: 'Приоритет', key: 'priority' },
        { header: 'Закрыто с SLA', key: 'total' },
        { header: 'В срок', key: 'onTime' },
        { header: 'Соблюдение, %', key: 'rate' },
      ],
      s.byPriority.map((p) => ({
        priority: PRIORITY_LABEL[p.priority] ?? p.priority,
        total: p.totalTracked,
        onTime: p.onTime,
        rate: p.rate ?? '—',
      })),
      'Нет заявок с заданным SLA за период',
    );
  }

  if (input.leads) {
    const l = input.leads;
    makeKpiSheet(wb, 'Лиды (итог)', [
      ['Лидов за период', l.total],
      ['Конверсия, %', l.conversion ?? '—'],
      ['Потенциал, ₽', l.totalPotentialRub, true],
      ['Выручка (выиграны), ₽', l.wonRevenueRub, true],
    ]);
    makeTableSheet(
      wb,
      'Лиды по стадиям',
      [
        { header: 'Стадия', key: 'stage' },
        { header: 'Количество', key: 'count' },
        { header: 'Сумма, ₽', key: 'valueRub', numFmt: MONEY_FMT },
      ],
      l.byStatus.map((s) => ({
        stage: LEAD_LABEL[s.status] ?? s.status,
        count: s.count,
        valueRub: s.valueRub,
      })),
      'Лидов за период нет',
    );
  }

  if (input.receivables) {
    makeTableSheet(
      wb,
      'Дебиторка',
      [
        { header: 'Счёт', key: 'invoice' },
        { header: 'Клиент', key: 'client', width: 30 },
        { header: 'Срок оплаты', key: 'dueDate', numFmt: DATE_FMT },
        { header: 'Дней просрочки', key: 'daysOverdue' },
        { header: 'Долг, ₽', key: 'remainingRub', numFmt: MONEY_FMT },
      ],
      input.receivables.map((r) => ({
        invoice: r.invoiceNumber,
        client: r.clientDisplayName || '—',
        dueDate: r.dueDate ? new Date(r.dueDate) : '—',
        daysOverdue: r.overdueDays,
        remainingRub: kopecksToRub(r.remainingKopecks),
      })),
      'Просроченных счетов нет',
    );
  }

  await downloadWorkbook(wb, `Аналитика_${input.periodLabel}.xlsx`);
}
