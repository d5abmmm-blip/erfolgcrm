/**
 * Excel «Журнал кассы» — выгрузка движения денег за выбранные фильтры.
 * Одна строка = одна операция. Доход/расход/перевод, счёт, статья, сумма, клиент, комментарий.
 */
import { DATE_FMT, MONEY_FMT, downloadWorkbook, getExcelJS, kopecksToRub, makeTableSheet } from './shared';

export interface CashJournalRow {
  kind: 'income' | 'expense' | 'transfer';
  accountName: string | null;
  counterAccountName: string | null;
  categoryName: string | null;
  amountKopecks: string;
  occurredOn: string; // ISO date
  comment: string | null;
  counterparty: string | null;
  clientName: string | null;
  source: 'manual' | 'payment';
}

const KIND_LABEL: Record<CashJournalRow['kind'], string> = {
  income: 'Доход',
  expense: 'Расход',
  transfer: 'Перевод',
};

interface SheetRow extends Record<string, unknown> {
  occurredOn: Date;
  kind: string;
  account: string;
  category: string;
  amountRub: number;
  client: string;
  counterparty: string;
  source: string;
  comment: string;
}

export async function downloadCashJournalXlsx(
  rows: CashJournalRow[],
  periodLabel: string,
): Promise<void> {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Erfolg CRM';
  wb.created = new Date();

  const sheetRows: SheetRow[] = rows.map((r) => ({
    occurredOn: new Date(r.occurredOn),
    kind: KIND_LABEL[r.kind],
    // Для перевода показываем «счёт → счёт».
    account:
      r.kind === 'transfer'
        ? `${r.accountName ?? '—'} → ${r.counterAccountName ?? '—'}`
        : (r.accountName ?? '—'),
    category: r.categoryName ?? '—',
    // Расход выгружаем со знаком минус — чтобы сумма столбца сходилась с сальдо.
    amountRub: (r.kind === 'expense' ? -1 : 1) * kopecksToRub(r.amountKopecks),
    client: r.clientName ?? '',
    counterparty: r.counterparty ?? '',
    source: r.source === 'payment' ? 'из заявки' : 'вручную',
    comment: r.comment ?? '',
  }));

  makeTableSheet<SheetRow>(
    wb,
    'Журнал кассы',
    [
      { header: 'Дата', key: 'occurredOn', numFmt: DATE_FMT },
      { header: 'Тип', key: 'kind' },
      { header: 'Счёт', key: 'account' },
      { header: 'Статья', key: 'category' },
      { header: 'Сумма, ₽', key: 'amountRub', numFmt: MONEY_FMT },
      { header: 'Клиент', key: 'client' },
      { header: 'Контрагент', key: 'counterparty' },
      { header: 'Источник', key: 'source' },
      { header: 'Комментарий', key: 'comment', width: 40 },
    ],
    sheetRows,
    'Операций за выбранный период нет',
  );

  await downloadWorkbook(wb, `Касса_${periodLabel}.xlsx`);
}
