/**
 * Общая кухня для Excel-выгрузок (exceljs).
 *
 * Вынесено из lib/excel/daily-summary.ts, чтобы «Сводка дня», «Аналитика за период» и
 * «Журнал кассы» строились одинаково: фирменная шапка, авто-ширина колонок, деньги в
 * рублях с форматом «# ##0,00», даты как настоящие Date (а не строки).
 */
import type ExcelJSType from 'exceljs';

/**
 * Lazy-loader: exceljs (~700KB) подгружается только при первом построении xlsx.
 * До этого момента в главном бандле его нет.
 */
let _excelJsPromise: Promise<typeof ExcelJSType> | null = null;
export async function getExcelJS(): Promise<typeof ExcelJSType> {
  if (_excelJsPromise) return _excelJsPromise;
  _excelJsPromise = import('exceljs').then((m) => m.default);
  return _excelJsPromise;
}

const PRIMARY = 'FF29ABE2'; // ARGB фирменного цвета (без #)

export const MONEY_FMT = '#,##0.00';
export const DATE_FMT = 'dd.mm.yyyy';

export const HEADER_FILL: ExcelJSType.FillPattern = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: PRIMARY },
};
export const HEADER_FONT: Partial<ExcelJSType.Font> = {
  bold: true,
  color: { argb: 'FFFFFFFF' },
};

/** Копейки (строка bigint) → рубли Number. В xlsx bigint хранить нельзя. */
export function kopecksToRub(kopStr: string | null | undefined): number {
  try {
    return Number(BigInt(kopStr ?? '0')) / 100;
  } catch {
    return 0;
  }
}

export function applyHeader(row: ExcelJSType.Row): void {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  row.height = 18;
}

export function autoSize(sheet: ExcelJSType.Worksheet, minWidth = 10, maxWidth = 50): void {
  sheet.columns.forEach((col) => {
    let max = minWidth;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      const s =
        typeof v === 'string'
          ? v
          : v instanceof Date
            ? '99.99.9999'
            : typeof v === 'number' || typeof v === 'boolean'
              ? String(v)
              : '';
      if (s.length > max) max = s.length;
    });
    col.width = Math.min(maxWidth, max + 2);
  });
}

export interface ColDef<T> {
  header: string;
  key: keyof T & string;
  width?: number;
  numFmt?: string;
}

/** Лист-таблица: шапка + строки. Пустой набор → курсивная заметка вместо пустоты. */
export function makeTableSheet<T extends Record<string, unknown>>(
  wb: ExcelJSType.Workbook,
  name: string,
  defs: Array<ColDef<T>>,
  rows: T[],
  emptyMessage: string,
): void {
  const sh = wb.addWorksheet(name);
  sh.columns = defs.map((d) => ({ header: d.header, key: d.key, width: d.width }));
  applyHeader(sh.getRow(1));
  if (rows.length === 0) {
    sh.addRow([emptyMessage]);
    sh.mergeCells(2, 1, 2, defs.length);
    const cell = sh.getCell('A2');
    cell.font = { italic: true, color: { argb: 'FF888888' } };
    return;
  }
  for (const r of rows) sh.addRow(r);
  for (const d of defs) {
    if (!d.numFmt) continue;
    sh.getColumn(d.key).numFmt = d.numFmt;
  }
  autoSize(sh);
}

/** Лист «показатель / значение» — для сводных KPI. */
export function makeKpiSheet(
  wb: ExcelJSType.Workbook,
  name: string,
  rows: Array<[label: string, value: string | number, isMoney?: boolean]>,
): void {
  const sh = wb.addWorksheet(name);
  sh.columns = [
    { header: 'Показатель', key: 'name' },
    { header: 'Значение', key: 'value' },
  ];
  applyHeader(sh.getRow(1));
  rows.forEach((r, i) => {
    sh.addRow({ name: r[0], value: r[1] });
    if (r[2]) sh.getCell(`B${i + 2}`).numFmt = MONEY_FMT;
  });
  autoSize(sh);
}

export async function workbookToBlob(wb: ExcelJSType.Workbook): Promise<Blob> {
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** Скачать книгу под указанным именем. */
export async function downloadWorkbook(wb: ExcelJSType.Workbook, filename: string): Promise<void> {
  const blob = await workbookToBlob(wb);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
