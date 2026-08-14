/**
 * Печатная форма журнала посещений — «Табель учёта рабочего времени» за месяц.
 *
 * Раскладка привычная по форме Т-13: строки — сотрудники, колонки — числа месяца,
 * в клетке буквенный код вида дня. Лист альбомный, иначе 31 колонка не помещается.
 *
 * Документ НЕ содержит ни рублей, ни расчётов: журнал фиксирует посещения, зарплата
 * считается отдельно (оклад + бонус + сделка). Подписи — составил и утвердил.
 */
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import { BRAND_GREY, BRAND_LIGHT_GREY, BRAND_PRIMARY } from './branding';
import { formatDate, type TenantData } from './shared';

export interface AttendanceSheetDay {
  day: number;
  isWeekend: boolean;
}

export interface AttendanceSheetRowInput {
  fullName: string;
  position: string;
  /** По коду на каждый день месяца, в том же порядке, что и `days`. */
  codes: string[];
  presentDays: number;
  /** Уже отформатированное «162 ч 30 мин» либо «—». */
  workedText: string;
}

export interface AttendanceLegendItem {
  code: string;
  label: string;
}

export interface PrintAttendanceSheetInput {
  tenant: TenantData;
  /** «Август 2026» */
  monthTitle: string;
  days: AttendanceSheetDay[];
  rows: AttendanceSheetRowInput[];
  legend: AttendanceLegendItem[];
  /** ФИО того, кто печатает табель — в строку «Составил». */
  compiledBy: string;
  /** ISO даты составления; по умолчанию — сегодня. */
  compiledAt?: string;
}

const WEEKEND_FILL = '#f2f2f2';

function headerBlock(input: PrintAttendanceSheetInput): Content {
  const t = input.tenant;
  const requisites: string[] = [];
  if (t.inn) requisites.push(`ИНН ${t.inn}${t.kpp ? ` / КПП ${t.kpp}` : ''}`);
  if (t.legalAddress) requisites.push(t.legalAddress);
  if (t.phone) requisites.push(`Тел.: ${t.phone}`);

  return {
    columns: [
      {
        width: '*',
        stack: [
          { text: t.displayName || 'ERFOLG', fontSize: 18, bold: true, color: BRAND_PRIMARY },
          {
            text: t.legalName,
            fontSize: 9,
            margin: [0, 3, 0, 0] as [number, number, number, number],
          },
        ],
      },
      {
        width: 'auto',
        alignment: 'right',
        stack: requisites.map((l) => ({ text: l, fontSize: 8, color: BRAND_GREY })),
      },
    ],
  };
}

function titleBlock(input: PrintAttendanceSheetInput): Content {
  return {
    margin: [0, 14, 0, 10],
    stack: [
      { text: 'Табель учёта рабочего времени', fontSize: 15, bold: true, alignment: 'center' },
      {
        text: input.monthTitle,
        fontSize: 11,
        color: BRAND_GREY,
        alignment: 'center',
        margin: [0, 3, 0, 0],
      },
    ],
  };
}

function sheetTable(input: PrintAttendanceSheetInput): Content {
  const dayHeader = input.days.map((d) => ({
    text: String(d.day),
    fontSize: 6,
    bold: true,
    alignment: 'center' as const,
    fillColor: d.isWeekend ? WEEKEND_FILL : undefined,
  }));

  const head = [
    { text: '№', fontSize: 7, bold: true, alignment: 'center' as const },
    { text: 'Сотрудник', fontSize: 7, bold: true },
    { text: 'Должность', fontSize: 7, bold: true },
    ...dayHeader,
    { text: 'Явок', fontSize: 6, bold: true, alignment: 'center' as const },
    { text: 'Отработано', fontSize: 6, bold: true, alignment: 'center' as const },
  ];

  const body = input.rows.map((r, i) => [
    { text: String(i + 1), fontSize: 7, alignment: 'center' as const },
    { text: r.fullName, fontSize: 7 },
    { text: r.position, fontSize: 7, color: BRAND_GREY },
    ...r.codes.map((code, dayIdx) => ({
      text: code,
      fontSize: 6,
      alignment: 'center' as const,
      fillColor: input.days[dayIdx]?.isWeekend ? WEEKEND_FILL : undefined,
    })),
    { text: String(r.presentDays), fontSize: 7, alignment: 'center' as const, bold: true },
    { text: r.workedText, fontSize: 6, alignment: 'center' as const },
  ]);

  return {
    margin: [0, 0, 0, 10],
    table: {
      headerRows: 1,
      // Числа месяца делят остаток поровну, остальные колонки — фиксированные.
      widths: [16, 120, 62, ...input.days.map(() => '*'), 26, 44],
      body: body.length > 0 ? [head, ...body] : [head],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => BRAND_LIGHT_GREY,
      vLineColor: () => BRAND_LIGHT_GREY,
      paddingTop: () => 2,
      paddingBottom: () => 2,
      paddingLeft: () => 2,
      paddingRight: () => 2,
    },
  };
}

function legendBlock(input: PrintAttendanceSheetInput): Content {
  return {
    text: `Условные обозначения: ${input.legend.map((l) => `${l.code} — ${l.label.toLowerCase()}`).join(', ')}.`,
    fontSize: 7,
    color: BRAND_GREY,
    margin: [0, 0, 0, 16],
  };
}

function emptyNote(input: PrintAttendanceSheetInput): Content {
  if (input.rows.length > 0) return '';
  return {
    text: 'За этот месяц отметок посещений нет.',
    fontSize: 9,
    italics: true,
    color: BRAND_GREY,
    margin: [0, 0, 0, 12],
  };
}

function signatures(input: PrintAttendanceSheetInput): Content {
  const line = (caption: string, name: string) => ({
    width: '*',
    stack: [
      {
        text: '____________________',
        fontSize: 10,
        margin: [0, 10, 0, 2] as [number, number, number, number],
      },
      { text: caption, fontSize: 8, color: BRAND_GREY },
      { text: name, fontSize: 9, margin: [0, 2, 0, 0] as [number, number, number, number] },
    ],
  });
  return {
    columns: [
      line('Составил (подпись)', input.compiledBy || '—'),
      { width: 40, text: '' },
      line('Утверждаю, директор (подпись)', input.tenant.director || '—'),
    ],
  };
}

export function buildAttendanceSheetDoc(input: PrintAttendanceSheetInput): TDocumentDefinitions {
  const compiledAt = input.compiledAt ?? new Date().toISOString();
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [24, 24, 24, 32],
    defaultStyle: { font: 'Roboto', fontSize: 9 },
    info: { title: `Табель ${input.monthTitle}` },
    content: [
      headerBlock(input),
      titleBlock(input),
      emptyNote(input),
      sheetTable(input),
      legendBlock(input),
      signatures(input),
      {
        text: `Дата составления: ${formatDate(compiledAt)}`,
        fontSize: 8,
        color: BRAND_GREY,
        margin: [0, 14, 0, 0],
      },
    ],
    footer: (currentPage, pageCount) => ({
      text: `Страница ${currentPage} из ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: BRAND_GREY,
      margin: [0, 10, 0, 0],
    }),
  };
}
