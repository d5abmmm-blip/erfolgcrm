/**
 * PDF «Сводка дня» — Этап 9.E.
 * Формирует одностраничный отчёт директора с метриками, просрочками, ТО и закрытыми заявками за день.
 */
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { BRAND_GREY, BRAND_LIGHT_GREY, BRAND_PRIMARY, ERFOLG_FALLBACK } from './branding';

export interface DailySummaryInput {
  date: string; // YYYY-MM-DD
  metrics: {
    revenuePeriodKopecks: string;
    revenueClosedPeriodKopecks: string;
    marginPeriodKopecks: string;
    marginPercent: number | null;
    receivablesTotalKopecks: string;
    overdueTotalKopecks: string;
    activeTicketsCount: number;
    slaAtRiskCount: number;
    lowStockCount: number;
    todayMaintenanceCount: number;
    overdueMaintenanceCount: number;
  };
  overdueInvoices: Array<{
    invoiceNumber: string;
    clientName: string | null;
    remainingKopecks: string;
    dueDate: string;
    daysOverdue: number;
  }>;
  slaAtRisk: Array<{
    ticketNumber: string;
    clientName: string | null;
    engineerName: string | null;
    hoursUntilSla: number;
  }>;
  lowStock: Array<{
    name: string;
    sku: string | null;
    currentStock: string;
    minStock: string;
    deficit: string;
    unit: string;
  }>;
  maintenanceToday: Array<{
    assetName: string;
    responsibleName: string | null;
    isOverdue: boolean;
  }>;
  closedTicketsToday: Array<{
    ticketNumber: string;
    clientName: string | null;
    totalAmountKopecks: string;
  }>;
  /** Опциональный displayName tenant'а; если не задан — берём из ERFOLG_FALLBACK. */
  tenantDisplayName?: string;
}

function formatRubFromKopecks(kopStr: string): string {
  const k = BigInt(kopStr);
  const rub = Number(k) / 100;
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(rub);
}

function formatRuDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function header(input: DailySummaryInput): Content {
  return {
    columns: [
      {
        width: '*',
        stack: [
          {
            text: input.tenantDisplayName ?? ERFOLG_FALLBACK.displayName,
            fontSize: 14,
            bold: true,
            color: BRAND_PRIMARY,
          },
          {
            text: 'Сводка дня',
            fontSize: 22,
            bold: true,
            margin: [0, 4, 0, 0],
          },
          {
            text: formatRuDate(input.date),
            fontSize: 11,
            color: BRAND_GREY,
            margin: [0, 2, 0, 0],
          },
        ],
      },
      {
        width: 'auto',
        stack: [
          {
            text: `Сформировано: ${new Date().toLocaleString('ru-RU')}`,
            fontSize: 9,
            color: BRAND_GREY,
            alignment: 'right',
          },
        ],
      },
    ],
  };
}

function metricBlock(label: string, value: string, hint?: string): Content {
  return {
    table: {
      widths: ['*'],
      body: [
        [
          {
            stack: [
              { text: label, fontSize: 8, color: BRAND_GREY, margin: [0, 0, 0, 2] },
              { text: value, fontSize: 14, bold: true },
              hint ? { text: hint, fontSize: 8, color: BRAND_GREY, margin: [0, 2, 0, 0] } : '',
            ],
            margin: [8, 8, 8, 8],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => BRAND_LIGHT_GREY,
      vLineColor: () => BRAND_LIGHT_GREY,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  };
}

function metricsGrid(input: DailySummaryInput): Content {
  const m = input.metrics;
  return {
    margin: [0, 16, 0, 0],
    columns: [
      metricBlock(
        'ВЫРУЧКА (ОПЛАЧЕНО)',
        formatRubFromKopecks(m.revenuePeriodKopecks),
        `Закрыто на ${formatRubFromKopecks(m.revenueClosedPeriodKopecks)}`,
      ),
      metricBlock(
        'МАРЖА',
        m.marginPercent !== null ? `${m.marginPercent.toFixed(1)}%` : '—',
        formatRubFromKopecks(m.marginPeriodKopecks),
      ),
      metricBlock(
        'ДЕБИТОРКА',
        formatRubFromKopecks(m.receivablesTotalKopecks),
        `Просрочка: ${formatRubFromKopecks(m.overdueTotalKopecks)}`,
      ),
      metricBlock('ЗАЯВКИ', String(m.activeTicketsCount), `SLA в риске: ${m.slaAtRiskCount}`),
    ],
    columnGap: 6,
  };
}

function maintenanceMetricsGrid(input: DailySummaryInput): Content {
  const m = input.metrics;
  return {
    margin: [0, 6, 0, 0],
    columns: [
      metricBlock('ДЕФИЦИТ ЗАПЧАСТЕЙ', `${m.lowStockCount} SKU`),
      metricBlock(
        'ТО НА СЕГОДНЯ',
        String(m.todayMaintenanceCount),
        `Просрочено: ${m.overdueMaintenanceCount}`,
      ),
      { text: '', width: '*' },
      { text: '', width: '*' },
    ],
    columnGap: 6,
  };
}

function sectionTitle(text: string): Content {
  return {
    text,
    fontSize: 12,
    bold: true,
    color: BRAND_PRIMARY,
    margin: [0, 16, 0, 6],
  };
}

function emptyMessage(text: string): Content {
  return {
    text,
    fontSize: 9,
    italics: true,
    color: BRAND_GREY,
    margin: [0, 2, 0, 6],
  };
}

function overdueInvoicesTable(input: DailySummaryInput): Content {
  if (input.overdueInvoices.length === 0) {
    return emptyMessage('Просроченных счетов нет.');
  }
  return {
    table: {
      headerRows: 1,
      widths: ['auto', '*', 'auto', 'auto', 'auto'],
      body: [
        [
          headerCell('Счёт'),
          headerCell('Клиент'),
          headerCell('Срок'),
          headerCell('Дней'),
          headerCell('Долг'),
        ],
        ...input.overdueInvoices.map((r) => [
          { text: r.invoiceNumber, fontSize: 9 },
          { text: r.clientName ?? '—', fontSize: 9 },
          { text: formatRuDate(r.dueDate), fontSize: 9 },
          { text: String(r.daysOverdue), fontSize: 9, alignment: 'right' as const },
          {
            text: formatRubFromKopecks(r.remainingKopecks),
            fontSize: 9,
            alignment: 'right' as const,
            bold: true,
          },
        ]),
      ],
    },
    layout: tableLayout(),
  };
}

function slaTable(input: DailySummaryInput): Content {
  if (input.slaAtRisk.length === 0) {
    return emptyMessage('Нет заявок на грани SLA.');
  }
  return {
    table: {
      headerRows: 1,
      widths: ['auto', '*', 'auto', 'auto'],
      body: [
        [headerCell('Заявка'), headerCell('Клиент'), headerCell('Инженер'), headerCell('До SLA')],
        ...input.slaAtRisk.map((r) => [
          { text: r.ticketNumber, fontSize: 9 },
          { text: r.clientName ?? '—', fontSize: 9 },
          { text: r.engineerName ?? '—', fontSize: 9 },
          {
            text:
              r.hoursUntilSla < 0
                ? `просрочено ${Math.abs(r.hoursUntilSla).toFixed(1)} ч`
                : `${r.hoursUntilSla.toFixed(1)} ч`,
            fontSize: 9,
            alignment: 'right' as const,
            color: r.hoursUntilSla < 0 ? '#cc0000' : '#aa6600',
          },
        ]),
      ],
    },
    layout: tableLayout(),
  };
}

function lowStockTable(input: DailySummaryInput): Content {
  if (input.lowStock.length === 0) {
    return emptyMessage('Все позиции в норме.');
  }
  return {
    table: {
      headerRows: 1,
      widths: ['*', 'auto', 'auto', 'auto'],
      body: [
        [
          headerCell('Позиция'),
          headerCell('Остаток'),
          headerCell('Минимум'),
          headerCell('Дефицит'),
        ],
        ...input.lowStock.map((r) => [
          {
            text: r.sku ? `${r.name} (${r.sku})` : r.name,
            fontSize: 9,
          },
          { text: `${r.currentStock} ${r.unit}`, fontSize: 9, alignment: 'right' as const },
          { text: `${r.minStock} ${r.unit}`, fontSize: 9, alignment: 'right' as const },
          {
            text: `${r.deficit} ${r.unit}`,
            fontSize: 9,
            alignment: 'right' as const,
            bold: true,
            color: '#cc0000',
          },
        ]),
      ],
    },
    layout: tableLayout(),
  };
}

function maintenanceTable(input: DailySummaryInput): Content {
  if (input.maintenanceToday.length === 0) {
    return emptyMessage('На сегодня плановых ТО нет.');
  }
  return {
    table: {
      headerRows: 1,
      widths: ['*', 'auto', 'auto'],
      body: [
        [headerCell('Техника'), headerCell('Ответственный'), headerCell('Статус')],
        ...input.maintenanceToday.map((r) => [
          { text: r.assetName, fontSize: 9 },
          { text: r.responsibleName ?? '—', fontSize: 9 },
          {
            text: r.isOverdue ? 'Просрочено' : 'Сегодня',
            fontSize: 9,
            color: r.isOverdue ? '#cc0000' : BRAND_GREY,
          },
        ]),
      ],
    },
    layout: tableLayout(),
  };
}

function closedTodayTable(input: DailySummaryInput): Content {
  if (input.closedTicketsToday.length === 0) {
    return emptyMessage('За день закрытых заявок нет.');
  }
  const total = input.closedTicketsToday.reduce((acc, r) => acc + BigInt(r.totalAmountKopecks), 0n);
  return {
    table: {
      headerRows: 1,
      widths: ['auto', '*', 'auto'],
      body: [
        [headerCell('Заявка'), headerCell('Клиент'), headerCell('Сумма')],
        ...input.closedTicketsToday.map((r) => [
          { text: r.ticketNumber, fontSize: 9 },
          { text: r.clientName ?? '—', fontSize: 9 },
          {
            text: formatRubFromKopecks(r.totalAmountKopecks),
            fontSize: 9,
            alignment: 'right' as const,
          },
        ]),
        [
          { text: '', fontSize: 9 },
          { text: 'Итого:', fontSize: 9, bold: true, alignment: 'right' as const },
          {
            text: formatRubFromKopecks(total.toString()),
            fontSize: 9,
            bold: true,
            alignment: 'right' as const,
          },
        ],
      ],
    },
    layout: tableLayout(),
  };
}

function headerCell(text: string) {
  return {
    text,
    fontSize: 8,
    color: BRAND_GREY,
    bold: true,
    fillColor: '#f5f5f5',
  };
}

function tableLayout() {
  return {
    hLineWidth: () => 0.5,
    vLineWidth: () => 0,
    hLineColor: () => BRAND_LIGHT_GREY,
    paddingTop: () => 4,
    paddingBottom: () => 4,
    paddingLeft: () => 6,
    paddingRight: () => 6,
  };
}

export function buildDailySummaryDoc(input: DailySummaryInput): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    pageMargins: [32, 32, 32, 40],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    content: [
      header(input),
      metricsGrid(input),
      maintenanceMetricsGrid(input),

      sectionTitle('Просроченные счета'),
      overdueInvoicesTable(input),

      sectionTitle('SLA в зоне риска'),
      slaTable(input),

      sectionTitle('Дефицит запчастей'),
      lowStockTable(input),

      sectionTitle('Плановые ТО на сегодня'),
      maintenanceTable(input),

      sectionTitle('Закрытые заявки за день'),
      closedTodayTable(input),
    ],
    footer: (currentPage, pageCount) => ({
      text: `Страница ${currentPage} из ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: BRAND_GREY,
      margin: [0, 12, 0, 0],
    }),
  };
}
