/**
 * Builder for "Счёт на оплату" (Invoice).
 */

import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';

import { amountInWords } from './amount-in-words';
import { BRAND_GREY, BRAND_LIGHT_GREY, BRAND_PRIMARY } from './branding';
import {
  type PrintInvoiceInput,
  formatDate,
  formatRubBare,
  vatRateLabel,
  vatRatePercent,
} from './shared';

export interface ExtendedPrintInvoiceInput extends PrintInvoiceInput {
  /** Optional issue date ISO; defaults to ticket.receivedAt. */
  issuedAt?: string;
  /** If set, used in header instead of ticket.ticketNumber. */
  invoiceNumber?: string;
  /** If set, used as the issue date instead of ticket.receivedAt (YYYY-MM-DD). */
  issueDate?: string;
  /** If set, adds a "Срок оплаты:" line to the header (YYYY-MM-DD). */
  dueDate?: string;
}

// Keep internal alias for backward compat within this file.
type BuildInvoiceInput = ExtendedPrintInvoiceInput;

function payeeBox(input: BuildInvoiceInput): Content {
  const t = input.tenant;
  const rows: [string, string][] = [
    ['Получатель', t.legalName],
    ['ИНН / КПП', `${t.inn ?? '—'} / ${t.kpp ?? '—'}`],
    ['Банк', t.bankName ?? '—'],
    ['БИК', t.bik ?? '—'],
    ['Р/счёт', t.bankAccount ?? '—'],
    ['К/счёт', t.correspondentAccount ?? '—'],
  ];
  return {
    margin: [0, 12, 0, 0],
    table: {
      widths: [100, '*'],
      body: rows.map(
        ([k, v]) =>
          [
            {
              text: k,
              fontSize: 9,
              color: BRAND_GREY,
              margin: [4, 3, 4, 3] as [number, number, number, number],
            },
            { text: v, fontSize: 10, margin: [4, 3, 4, 3] as [number, number, number, number] },
          ] as TableCell[],
      ),
    },
    layout: {
      hLineColor: () => BRAND_LIGHT_GREY,
      vLineColor: () => BRAND_LIGHT_GREY,
    },
  };
}

function partiesBlock(input: BuildInvoiceInput): Content {
  const t = input.tenant;
  const c = input.client;
  return {
    columns: [
      {
        width: '*',
        stack: [
          { text: 'Поставщик:', bold: true, fontSize: 10 },
          { text: t.legalName, fontSize: 10 },
          { text: `ИНН ${t.inn ?? '—'}${t.kpp ? ` / КПП ${t.kpp}` : ''}`, fontSize: 9 },
          ...(t.legalAddress ? [{ text: t.legalAddress, fontSize: 9 }] : []),
        ],
      },
      {
        width: '*',
        stack: [
          { text: 'Покупатель:', bold: true, fontSize: 10 },
          { text: c.displayName, fontSize: 10 },
          { text: `ИНН ${c.inn ?? '—'}${c.kpp ? ` / КПП ${c.kpp}` : ''}`, fontSize: 9 },
          ...(c.legalAddress ? [{ text: c.legalAddress, fontSize: 9 }] : []),
        ],
      },
    ],
    columnGap: 16,
    margin: [0, 12, 0, 0],
  };
}

function linesTable(input: BuildInvoiceInput): Content {
  const headerCell = (text: string, alignment: 'left' | 'right' | 'center' = 'left'): Content => ({
    text,
    bold: true,
    color: 'white',
    fillColor: BRAND_PRIMARY,
    fontSize: 9,
    alignment,
    margin: [4, 4, 4, 4],
  });
  const cell = (text: string, alignment: 'left' | 'right' | 'center' = 'left'): Content => ({
    text,
    fontSize: 9,
    alignment,
    margin: [4, 3, 4, 3],
  });

  const vatPercent = vatRatePercent(input.workOrder.vatRate);
  const isWithoutVat = input.workOrder.vatRate === 'without_vat';

  const body: TableCell[][] = [
    [
      headerCell('№'),
      headerCell('Наименование'),
      headerCell('Кол-во', 'right'),
      headerCell('Ед.'),
      headerCell('Цена', 'right'),
      headerCell('Сумма без НДС', 'right'),
      headerCell('НДС', 'right'),
      headerCell('Всего', 'right'),
    ],
  ];

  input.workOrder.lines.forEach((line, idx) => {
    // Stored amountKopecks is treated as the gross amount including VAT.
    // For the invoice we show net + VAT split per line.
    let net: number;
    let vat: number;
    if (isWithoutVat || vatPercent === 0) {
      net = line.amountKopecks;
      vat = 0;
    } else {
      // amount * rate / (100 + rate) gives the VAT portion of an inclusive total.
      vat = Math.round((line.amountKopecks * vatPercent) / (100 + vatPercent));
      net = line.amountKopecks - vat;
    }
    body.push([
      cell(String(idx + 1), 'right'),
      cell(line.name),
      cell(String(line.quantity), 'right'),
      cell(line.unit, 'center'),
      cell(formatRubBare(line.unitPriceKopecks), 'right'),
      cell(formatRubBare(net), 'right'),
      cell(isWithoutVat ? 'Без НДС' : formatRubBare(vat), 'right'),
      cell(formatRubBare(line.amountKopecks), 'right'),
    ]);
  });

  return {
    margin: [0, 12, 0, 0],
    table: {
      headerRows: 1,
      widths: [18, '*', 36, 28, 60, 60, 50, 60],
      body,
    },
    layout: {
      hLineColor: () => BRAND_LIGHT_GREY,
      vLineColor: () => BRAND_LIGHT_GREY,
    },
  };
}

function totalsBlock(input: BuildInvoiceInput): Content {
  const total = input.workOrder.totalAmountKopecks;
  const vatPercent = vatRatePercent(input.workOrder.vatRate);
  const isWithoutVat = input.workOrder.vatRate === 'without_vat';
  const vatAmount =
    isWithoutVat || vatPercent === 0 ? 0 : Math.round((total * vatPercent) / (100 + vatPercent));

  const lineCount = input.workOrder.lines.length;
  return {
    margin: [0, 8, 0, 0],
    stack: [
      {
        text: `Всего наименований ${lineCount} на сумму ${formatRubBare(total)} руб.`,
        fontSize: 10,
      },
      {
        text: isWithoutVat
          ? 'Без НДС.'
          : `В том числе НДС ${vatRateLabel(input.workOrder.vatRate)}: ${formatRubBare(vatAmount)} руб.`,
        fontSize: 10,
        margin: [0, 2, 0, 0] as [number, number, number, number],
      },
      {
        text: `Сумма прописью: ${amountInWords(total)}.`,
        fontSize: 10,
        bold: true,
        margin: [0, 6, 0, 0] as [number, number, number, number],
      },
    ],
  };
}

function signaturesBlock(input: BuildInvoiceInput): Content {
  return {
    margin: [0, 22, 0, 0],
    columns: [
      {
        width: '*',
        stack: [
          { text: 'Руководитель', bold: true, fontSize: 10 },
          {
            text: '_________________________',
            margin: [0, 14, 0, 0] as [number, number, number, number],
          },
          {
            text: input.tenant.director || '',
            fontSize: 9,
            color: BRAND_GREY,
            margin: [0, 2, 0, 0] as [number, number, number, number],
          },
          {
            text: 'М.П.',
            fontSize: 9,
            color: BRAND_GREY,
            margin: [0, 6, 0, 0] as [number, number, number, number],
          },
        ],
      },
      {
        width: '*',
        stack: [
          { text: 'Главный бухгалтер', bold: true, fontSize: 10 },
          {
            text: '_________________________',
            margin: [0, 14, 0, 0] as [number, number, number, number],
          },
        ],
      },
    ],
    columnGap: 30,
  };
}

function headerBlock(input: BuildInvoiceInput): Content {
  const t = input.tenant;
  const requisites: string[] = [];
  if (t.inn) requisites.push(`ИНН ${t.inn}${t.kpp ? ` / КПП ${t.kpp}` : ''}`);
  if (t.ogrn) requisites.push(`ОГРН ${t.ogrn}`);
  if (t.legalAddress) requisites.push(t.legalAddress);
  if (t.phone) requisites.push(`Тел.: ${t.phone}`);
  if (t.email) requisites.push(`E-mail: ${t.email}`);

  return {
    columns: [
      {
        width: '*',
        stack: [
          {
            text: t.displayName || 'ERFOLG',
            fontSize: 22,
            bold: true,
            color: BRAND_PRIMARY,
          },
          ...(t.slogan
            ? [
                {
                  text: t.slogan,
                  fontSize: 9,
                  color: BRAND_GREY,
                  margin: [0, 2, 0, 0] as [number, number, number, number],
                },
              ]
            : []),
          {
            text: t.legalName,
            fontSize: 9,
            margin: [0, 4, 0, 0] as [number, number, number, number],
          },
        ],
      },
      {
        width: '*',
        stack: requisites.map((l) => ({ text: l, fontSize: 8, color: BRAND_GREY })),
        alignment: 'right',
      },
    ],
  };
}

export function buildInvoiceDoc(input: ExtendedPrintInvoiceInput): TDocumentDefinitions {
  const resolvedNumber = input.invoiceNumber ?? input.ticket.ticketNumber;
  const resolvedIssueDate = input.issueDate ?? input.issuedAt ?? input.ticket.receivedAt;

  const headerTitle: Content = {
    text: `Счёт на оплату № ${resolvedNumber} от ${formatDate(resolvedIssueDate)}`,
    bold: true,
    fontSize: 13,
    color: BRAND_PRIMARY,
    alignment: 'center',
    margin: [0, 14, 0, 0],
  };

  const dueDateLine: Content[] = input.dueDate
    ? [
        {
          text: `Срок оплаты: ${formatDate(input.dueDate)}`,
          fontSize: 10,
          alignment: 'center',
          color: BRAND_GREY,
          margin: [0, 3, 0, 0],
        },
      ]
    : [];

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [42, 42, 42, 42],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    info: {
      title: `Счёт ${resolvedNumber}`,
      author: input.tenant.legalName,
      subject: 'Счёт на оплату',
    },
    content: [
      headerBlock(input),
      {
        canvas: [
          {
            type: 'line',
            x1: 0,
            y1: 4,
            x2: 515,
            y2: 4,
            lineWidth: 1,
            lineColor: BRAND_PRIMARY,
          },
        ],
        margin: [0, 6, 0, 0],
      },
      payeeBox(input),
      headerTitle,
      ...dueDateLine,
      partiesBlock(input),
      linesTable(input),
      totalsBlock(input),
      signaturesBlock(input),
    ],
  };
}
