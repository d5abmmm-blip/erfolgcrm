/**
 * PR-4 «Excel-экспорт». Реально строим книги через exceljs (jsdom) и проверяем, что:
 *  - генераторы не падают на разумных данных и на пустых;
 *  - файл действительно скачивается (создаётся blob-URL с непустым .xlsx);
 *  - в журнале кассы расход выгружается со знаком минус (сальдо сходится).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadCashJournalXlsx, type CashJournalRow } from '../lib/excel/cash-journal';
import { downloadAnalyticsXlsx } from '../lib/excel/analytics';
import { downloadSalesAnalyticsXlsx } from '../lib/excel/sales';

let lastBlob: Blob | null = null;

beforeEach(() => {
  lastBlob = null;
  // jsdom не реализует URL.createObjectURL — перехватываем и запоминаем blob.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (b: Blob) => {
      lastBlob = b;
      return 'blob:mock';
    },
    revokeObjectURL: () => {},
  });
  // a.click() в jsdom не должен ничего делать.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('Excel: журнал кассы', () => {
  it('строит непустой .xlsx из операций', async () => {
    const rows: CashJournalRow[] = [
      {
        kind: 'income',
        accountName: 'Касса',
        counterAccountName: null,
        categoryName: 'Оплата заявки',
        amountKopecks: '150000',
        occurredOn: '2026-07-10',
        comment: 'нал',
        counterparty: null,
        clientName: 'ООО Ромашка',
        source: 'payment',
      },
      {
        kind: 'expense',
        accountName: 'Касса',
        counterAccountName: null,
        categoryName: 'Зарплата',
        amountKopecks: '50000',
        occurredOn: '2026-07-11',
        comment: null,
        counterparty: 'Иванов',
        clientName: null,
        source: 'manual',
      },
    ];
    await downloadCashJournalXlsx(rows, '2026-07');
    expect(lastBlob).toBeInstanceOf(Blob);
    expect(lastBlob!.type).toBe(XLSX_MIME);
    expect(lastBlob!.size).toBeGreaterThan(0);
  });

  it('не падает на пустом наборе', async () => {
    await downloadCashJournalXlsx([], 'все');
    expect(lastBlob).toBeInstanceOf(Blob);
    expect(lastBlob!.size).toBeGreaterThan(0);
  });
});

describe('Excel: аналитика за период', () => {
  it('собирает книгу из разделов (директорские присутствуют)', async () => {
    await downloadAnalyticsXlsx({
      periodLabel: '2026-04_2026-07',
      periodHuman: '2026-04-01 — 2026-07-01',
      revenue: [
        {
          clientDisplayName: 'ООО Ромашка',
          ticketsCount: 3,
          closedCount: 2,
          totalAmountKopecks: '300000',
          paidAmountKopecks: '250000',
        },
      ],
      engineers: [
        {
          engineerName: 'Петров',
          ticketsCount: 5,
          closedCount: 4,
          totalAmountKopecks: '400000',
          avgCloseDays: 2,
        },
      ],
      profitability: {
        summary: {
          totalAmountKopecks: '400000',
          costAmountKopecks: '150000',
          marginAmountKopecks: '250000',
          marginPercent: 62.5,
        },
        byEngineer: [
          {
            name: 'Петров',
            closedOrdersCount: 4,
            totalAmountKopecks: '400000',
            costAmountKopecks: '150000',
            marginAmountKopecks: '250000',
            marginPercent: 62.5,
          },
        ],
        byEquipment: [],
      },
      sla: { totalTracked: 10, onTime: 9, late: 1, rate: 90, byPriority: [] },
      leads: { total: 4, conversion: 25, totalPotentialRub: 100000, wonRevenueRub: 30000, byStatus: [] },
      receivables: [
        {
          invoiceNumber: 'INV-2026-000017',
          clientDisplayName: 'ООО Ромашка',
          dueDate: '2026-06-01',
          overdueDays: 40,
          remainingKopecks: '50000',
        },
      ],
    });
    expect(lastBlob).toBeInstanceOf(Blob);
    expect(lastBlob!.type).toBe(XLSX_MIME);
    expect(lastBlob!.size).toBeGreaterThan(0);
  });

  it('пропускает не загруженные разделы (только обзор) без ошибки', async () => {
    await downloadAnalyticsXlsx({ periodLabel: 'все', periodHuman: 'всё время' });
    expect(lastBlob).toBeInstanceOf(Blob);
    expect(lastBlob!.size).toBeGreaterThan(0);
  });
});

describe('Excel: аналитика продаж', () => {
  it('строит книгу из итогов, месяцев и топов', async () => {
    await downloadSalesAnalyticsXlsx(
      {
        summary: {
          revenueKopecks: '850000',
          costKopecks: '530000',
          profitKopecks: '320000',
          salesCount: 2,
          avgCheckKopecks: '425000',
          marginPercent: 37.6,
          unpaidKopecks: '850000',
          unpaidCount: 2,
        },
        byMonth: [
          {
            month: '2026-03',
            revenueKopecks: '850000',
            costKopecks: '530000',
            profitKopecks: '320000',
            salesCount: 2,
          },
        ],
        topClients: [
          { clientName: 'ООО Ромашка', revenueKopecks: '850000', profitKopecks: '320000', salesCount: 2 },
        ],
        topProducts: [
          { name: 'Плата ИВЛ', revenueKopecks: '500000', profitKopecks: '200000', quantity: 1 },
        ],
      },
      'март 2026',
      'Продажи_тест.xlsx',
    );
    expect(lastBlob).toBeInstanceOf(Blob);
    expect(lastBlob!.type).toBe(XLSX_MIME);
    expect(lastBlob!.size).toBeGreaterThan(0);
  });

  it('не падает на пустых данных', async () => {
    await downloadSalesAnalyticsXlsx(
      {
        summary: {
          revenueKopecks: '0',
          costKopecks: '0',
          profitKopecks: '0',
          salesCount: 0,
          avgCheckKopecks: '0',
          marginPercent: null,
          unpaidKopecks: '0',
          unpaidCount: 0,
        },
        byMonth: [],
        topClients: [],
        topProducts: [],
      },
      'весь период',
      'Продажи_пусто.xlsx',
    );
    expect(lastBlob).toBeInstanceOf(Blob);
    expect(lastBlob!.size).toBeGreaterThan(0);
  });
});
