/**
 * Excel «Сводка дня» — Stage 10'.E.
 *
 * Те же данные, что в PDF-варианте (см. lib/pdf/daily-summary.ts), но в формате,
 * пригодном для дальнейшей обработки в 1С / Excel:
 *   - лист «Метрики» — KPI как key/value;
 *   - лист «Просроченные счета»;
 *   - лист «SLA в риске»;
 *   - лист «Дефицит запчастей»;
 *   - лист «ТО на сегодня»;
 *   - лист «Закрытые заявки».
 *
 * Деньги — в рублях (Number, формат «0.00»). Даты — Date с формат-маской dd.mm.yyyy.
 */
import type ExcelJSType from 'exceljs';
import type { DailySummaryInput } from '../pdf/daily-summary';
import {
  applyHeader,
  autoSize,
  getExcelJS,
  kopecksToRub,
  makeTableSheet,
  workbookToBlob,
} from './shared';

function metricsSheet(wb: ExcelJSType.Workbook, input: DailySummaryInput): void {
  const m = input.metrics;
  const sh = wb.addWorksheet('Метрики');
  sh.columns = [
    { header: 'Показатель', key: 'name' },
    { header: 'Значение', key: 'value' },
    { header: 'Комментарий', key: 'note' },
  ];
  applyHeader(sh.getRow(1));

  const rows: Array<[string, string | number, string]> = [
    ['Дата', input.date, ''],
    ['Выручка (оплачено), ₽', kopecksToRub(m.revenuePeriodKopecks), ''],
    ['Выручка по закрытым нарядам, ₽', kopecksToRub(m.revenueClosedPeriodKopecks), ''],
    ['Маржа, ₽', kopecksToRub(m.marginPeriodKopecks), ''],
    ['Маржа, %', m.marginPercent === null ? '—' : Number(m.marginPercent.toFixed(2)), ''],
    ['Дебиторка, ₽', kopecksToRub(m.receivablesTotalKopecks), ''],
    ['Просрочка, ₽', kopecksToRub(m.overdueTotalKopecks), ''],
    ['Активных заявок, шт.', m.activeTicketsCount, ''],
    ['SLA в зоне риска, шт.', m.slaAtRiskCount, ''],
    ['Дефицит запчастей, SKU', m.lowStockCount, ''],
    ['Плановых ТО на сегодня, шт.', m.todayMaintenanceCount, ''],
    ['Просроченных ТО, шт.', m.overdueMaintenanceCount, ''],
  ];
  for (const r of rows) {
    sh.addRow({ name: r[0], value: r[1], note: r[2] });
  }

  // Money formatting на колонке B для денежных строк
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const cell = sh.getCell(`B${i + 2}`);
    if (typeof r[1] === 'number' && r[0].includes('₽')) {
      cell.numFmt = '#,##0.00';
    }
  }
  autoSize(sh);
}

export async function buildDailySummaryWorkbook(input: DailySummaryInput): Promise<Blob> {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = input.tenantDisplayName ?? 'Erfolg CRM';
  wb.created = new Date();

  metricsSheet(wb, input);

  makeTableSheet(
    wb,
    'Просроченные счета',
    [
      { header: 'Счёт', key: 'invoiceNumber' },
      { header: 'Клиент', key: 'clientName' },
      { header: 'Срок', key: 'dueDate', numFmt: 'dd.mm.yyyy' },
      { header: 'Дней просрочки', key: 'daysOverdue' },
      { header: 'Долг, ₽', key: 'remainingRub', numFmt: '#,##0.00' },
    ],
    input.overdueInvoices.map((r) => ({
      invoiceNumber: r.invoiceNumber,
      clientName: r.clientName ?? '—',
      dueDate: parseIsoDate(r.dueDate),
      daysOverdue: r.daysOverdue,
      remainingRub: kopecksToRub(r.remainingKopecks),
    })),
    'Просроченных счетов нет',
  );

  makeTableSheet(
    wb,
    'SLA в риске',
    [
      { header: 'Заявка', key: 'ticketNumber' },
      { header: 'Клиент', key: 'clientName' },
      { header: 'Инженер', key: 'engineerName' },
      { header: 'Часов до SLA', key: 'hoursUntilSla', numFmt: '0.0' },
    ],
    input.slaAtRisk.map((r) => ({
      ticketNumber: r.ticketNumber,
      clientName: r.clientName ?? '—',
      engineerName: r.engineerName ?? '—',
      hoursUntilSla: Number(r.hoursUntilSla.toFixed(2)),
    })),
    'Нет заявок на грани SLA',
  );

  makeTableSheet(
    wb,
    'Дефицит запчастей',
    [
      { header: 'Позиция', key: 'name' },
      { header: 'SKU', key: 'sku' },
      { header: 'Остаток', key: 'currentStock' },
      { header: 'Минимум', key: 'minStock' },
      { header: 'Дефицит', key: 'deficit' },
      { header: 'Ед.', key: 'unit' },
    ],
    input.lowStock.map((r) => ({
      name: r.name,
      sku: r.sku ?? '',
      currentStock: r.currentStock,
      minStock: r.minStock,
      deficit: r.deficit,
      unit: r.unit,
    })),
    'Все позиции в норме',
  );

  makeTableSheet(
    wb,
    'ТО на сегодня',
    [
      { header: 'Техника', key: 'assetName' },
      { header: 'Ответственный', key: 'responsibleName' },
      { header: 'Статус', key: 'status' },
    ],
    input.maintenanceToday.map((r) => ({
      assetName: r.assetName,
      responsibleName: r.responsibleName ?? '—',
      status: r.isOverdue ? 'Просрочено' : 'Сегодня',
    })),
    'На сегодня плановых ТО нет',
  );

  makeTableSheet(
    wb,
    'Закрытые заявки',
    [
      { header: 'Заявка', key: 'ticketNumber' },
      { header: 'Клиент', key: 'clientName' },
      { header: 'Сумма, ₽', key: 'totalRub', numFmt: '#,##0.00' },
    ],
    input.closedTicketsToday.map((r) => ({
      ticketNumber: r.ticketNumber,
      clientName: r.clientName ?? '—',
      totalRub: kopecksToRub(r.totalAmountKopecks),
    })),
    'За день закрытых заявок нет',
  );

  return workbookToBlob(wb);
}

function parseIsoDate(iso: string): Date {
  // dd-mm-yyyy → Date в UTC, иначе Excel сместит на сутки в локалях с TZ.
  return new Date(iso);
}

export async function downloadDailySummaryXlsx(input: DailySummaryInput): Promise<void> {
  const blob = await buildDailySummaryWorkbook(input);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Сводка_${input.date}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
