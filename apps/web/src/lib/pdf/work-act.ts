/**
 * Builder for "Акт выполненных работ" (Work Act).
 * Shares the ticket number with the corresponding intake act.
 */

import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';

import { BRAND_GREY, BRAND_LIGHT_GREY, BRAND_PRIMARY } from './branding';
import {
  type LineType,
  type PrintWorkActInput,
  type WorkOrderLine,
  formatDate,
  formatRubBare,
  vatRateLabel,
} from './shared';

interface BuildWorkActInput extends PrintWorkActInput {
  /** PNG data URL or empty string. */
  barcodeDataUrl: string;
  /** Optional act issue date ISO; defaults to ticket.receivedAt. */
  issuedAt?: string;
}

function headerBlock(input: BuildWorkActInput): Content {
  const t = input.tenant;
  const requisites: string[] = [];
  if (t.inn) requisites.push(`ИНН ${t.inn}${t.kpp ? ` / КПП ${t.kpp}` : ''}`);
  if (t.ogrn) requisites.push(`ОГРН ${t.ogrn}`);
  if (t.legalAddress) requisites.push(t.legalAddress);
  if (t.phone) requisites.push(`Тел.: ${t.phone}`);
  if (t.email) requisites.push(`E-mail: ${t.email}`);
  if (t.licenseSeries && t.licenseNumber) {
    requisites.push(
      `Лицензия ${t.licenseSeries} № ${t.licenseNumber}${
        t.licenseDate ? ` от ${formatDate(t.licenseDate)}` : ''
      }`,
    );
  }

  return {
    columns: [
      {
        width: '*',
        stack: [
          { text: t.displayName || 'ERFOLG', fontSize: 22, bold: true, color: BRAND_PRIMARY },
          ...(t.slogan
            ? [{ text: t.slogan, fontSize: 9, color: BRAND_GREY, margin: [0, 2, 0, 0] as [number, number, number, number] }]
            : []),
          { text: t.legalName, fontSize: 9, margin: [0, 4, 0, 0] as [number, number, number, number] },
        ],
      },
      {
        width: '*',
        alignment: 'right',
        stack: requisites.map((l) => ({ text: l, fontSize: 8, color: BRAND_GREY })),
      },
    ],
  };
}

function partiesBlock(input: BuildWorkActInput): Content {
  const t = input.tenant;
  const c = input.client;
  return {
    columns: [
      {
        width: '*',
        stack: [
          { text: 'Исполнитель:', bold: true, fontSize: 10 },
          { text: t.legalName, fontSize: 10 },
          { text: `ИНН ${t.inn ?? '—'}${t.kpp ? ` / КПП ${t.kpp}` : ''}`, fontSize: 9 },
        ],
      },
      {
        width: '*',
        stack: [
          { text: 'Заказчик:', bold: true, fontSize: 10 },
          { text: c.displayName, fontSize: 10 },
          { text: `ИНН ${c.inn ?? '—'}${c.kpp ? ` / КПП ${c.kpp}` : ''}`, fontSize: 9 },
        ],
      },
    ],
    columnGap: 16,
    margin: [0, 12, 0, 0],
  };
}

function assetLine(input: BuildWorkActInput): Content {
  const a = input.asset;
  if (!a) return { text: '' };
  const parts: string[] = [a.model];
  if (a.manufacturer) parts.push(a.manufacturer);
  if (a.serialNumber) parts.push(`s/n ${a.serialNumber}`);
  if (a.inventoryNumber) parts.push(`инв. ${a.inventoryNumber}`);
  return {
    margin: [0, 8, 0, 0],
    text: [
      { text: 'Оборудование: ', bold: true, fontSize: 10 },
      { text: parts.join(', '), fontSize: 10 },
    ],
  };
}

function buildLinesTable(
  title: string,
  lines: WorkOrderLine[],
): Content | null {
  if (lines.length === 0) return null;

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

  const body: TableCell[][] = [
    [
      headerCell('№'),
      headerCell('Наименование'),
      headerCell('Кол-во', 'right'),
      headerCell('Ед.'),
      headerCell('Цена', 'right'),
      headerCell('Сумма', 'right'),
    ],
  ];

  lines.forEach((line, idx) => {
    body.push([
      cell(String(idx + 1), 'right'),
      cell(line.name),
      cell(String(line.quantity), 'right'),
      cell(line.unit, 'center'),
      cell(formatRubBare(line.unitPriceKopecks), 'right'),
      cell(formatRubBare(line.amountKopecks), 'right'),
    ]);
  });

  return {
    margin: [0, 10, 0, 0],
    stack: [
      { text: title, bold: true, fontSize: 11, color: BRAND_PRIMARY },
      {
        margin: [0, 4, 0, 0],
        table: {
          headerRows: 1,
          widths: [18, '*', 36, 28, 70, 80],
          body,
        },
        layout: {
          hLineColor: () => BRAND_LIGHT_GREY,
          vLineColor: () => BRAND_LIGHT_GREY,
        },
      },
    ],
  };
}

function totalsBlock(input: BuildWorkActInput): Content {
  const wo = input.workOrder;
  const totalsRow = (label: string, kop: number, bold = false): TableCell[] => [
    { text: label, fontSize: 10, bold, alignment: 'right', margin: [4, 3, 4, 3] },
    {
      text: `${formatRubBare(kop)} ₽`,
      fontSize: 10,
      bold,
      alignment: 'right',
      margin: [4, 3, 4, 3],
    },
  ];
  const body: TableCell[][] = [];
  if (wo.worksAmountKopecks > 0) body.push(totalsRow('Работы:', wo.worksAmountKopecks));
  if (wo.partsAmountKopecks > 0) body.push(totalsRow('Запчасти:', wo.partsAmountKopecks));
  if (wo.expensesAmountKopecks > 0) body.push(totalsRow('Прочие расходы:', wo.expensesAmountKopecks));
  body.push(
    totalsRow(
      `ИТОГО (включая НДС ${vatRateLabel(wo.vatRate)}):`,
      wo.totalAmountKopecks,
      true,
    ),
  );

  return {
    margin: [0, 10, 0, 0],
    columns: [
      { width: '*', text: '' },
      {
        width: 260,
        table: { widths: ['*', 100], body },
        layout: 'noBorders',
      },
    ],
  };
}

function diagnosisBlock(input: BuildWorkActInput): Content | null {
  const wo = input.workOrder;
  const sections: Content[] = [];
  if (wo.diagnosis) {
    sections.push({
      stack: [
        { text: 'Диагностика:', bold: true, fontSize: 10 },
        { text: wo.diagnosis, fontSize: 9, margin: [0, 2, 0, 0] as [number, number, number, number] },
      ],
      margin: [0, 6, 0, 0],
    });
  }
  if (wo.repairDescription) {
    sections.push({
      stack: [
        { text: 'Выполненные работы:', bold: true, fontSize: 10 },
        { text: wo.repairDescription, fontSize: 9, margin: [0, 2, 0, 0] as [number, number, number, number] },
      ],
      margin: [0, 6, 0, 0],
    });
  }
  if (wo.recommendation) {
    sections.push({
      stack: [
        { text: 'Рекомендации:', bold: true, fontSize: 10 },
        { text: wo.recommendation, fontSize: 9, margin: [0, 2, 0, 0] as [number, number, number, number] },
      ],
      margin: [0, 6, 0, 0],
    });
  }
  return sections.length > 0 ? { stack: sections } : null;
}

function warrantyBlock(hasParts: boolean): Content {
  // Гарантия даётся ТОЛЬКО на установленные запчасти (6 месяцев). На сами работы
  // (ремонт без замены з/ч) гарантия не предоставляется. Если запчастей не было —
  // гарантии нет вовсе.
  const warrantyText = hasParts
    ? 'Гарантия на установленные запасные части — 6 месяцев со дня подписания акта. На выполненные работы (ремонт) гарантия не предоставляется.'
    : 'Гарантия на выполненные работы не предоставляется.';
  return {
    margin: [0, 12, 0, 0],
    stack: [
      { text: 'Гарантия', bold: true, color: BRAND_PRIMARY, fontSize: 11 },
      {
        text: warrantyText,
        fontSize: 9,
        margin: [0, 2, 0, 0] as [number, number, number, number],
      },
      {
        text:
          'Стороны претензий по объёму, качеству и срокам выполнения работ не имеют. Оборудование передано Заказчику в исправном состоянии.',
        fontSize: 9,
        margin: [0, 4, 0, 0] as [number, number, number, number],
      },
    ],
  };
}

function signaturesBlock(input: BuildWorkActInput): Content {
  const clientName = input.client.contactName?.trim() || input.client.displayName;
  return {
    margin: [0, 18, 0, 0],
    columns: [
      {
        width: '*',
        stack: [
          { text: 'Исполнитель', bold: true, fontSize: 10 },
          { text: '_________________________', margin: [0, 14, 0, 0] as [number, number, number, number] },
          {
            text: input.tenant.director || '',
            fontSize: 9,
            color: BRAND_GREY,
            margin: [0, 2, 0, 0] as [number, number, number, number],
          },
          { text: 'М.П.', fontSize: 9, color: BRAND_GREY, margin: [0, 6, 0, 0] as [number, number, number, number] },
        ],
      },
      {
        width: '*',
        stack: [
          { text: 'Заказчик', bold: true, fontSize: 10 },
          { text: '_________________________', margin: [0, 14, 0, 0] as [number, number, number, number] },
          {
            text: clientName,
            fontSize: 9,
            color: BRAND_GREY,
            margin: [0, 2, 0, 0] as [number, number, number, number],
          },
        ],
      },
    ],
    columnGap: 30,
  };
}

export function buildWorkActDoc(input: BuildWorkActInput): TDocumentDefinitions {
  const issueDate = input.issuedAt ?? input.ticket.receivedAt;
  const works = input.workOrder.lines.filter((l) => l.lineType === ('work' as LineType));
  const parts = input.workOrder.lines.filter((l) => l.lineType === ('part' as LineType));
  const expenses = input.workOrder.lines.filter((l) => l.lineType === ('expense' as LineType));

  const content: Content[] = [
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
    {
      text: `АКТ ВЫПОЛНЕННЫХ РАБОТ № ${input.ticket.ticketNumber} от ${formatDate(issueDate)}`,
      bold: true,
      fontSize: 13,
      color: BRAND_PRIMARY,
      alignment: 'center',
      margin: [0, 14, 0, 0],
    },
    partiesBlock(input),
    assetLine(input),
  ];

  const worksTable = buildLinesTable('Работы', works);
  if (worksTable) content.push(worksTable);
  const partsTable = buildLinesTable('Запчасти', parts);
  if (partsTable) content.push(partsTable);
  const expensesTable = buildLinesTable('Прочие расходы', expenses);
  if (expensesTable) content.push(expensesTable);

  content.push(totalsBlock(input));

  const diag = diagnosisBlock(input);
  if (diag) content.push(diag);

  content.push(warrantyBlock(parts.length > 0));

  if (input.barcodeDataUrl) {
    content.push({
      margin: [0, 12, 0, 0],
      columns: [
        { width: '*', text: '' },
        {
          width: 'auto',
          stack: [
            { image: input.barcodeDataUrl, width: 130, alignment: 'right' },
            {
              text: input.ticket.barcode,
              fontSize: 8,
              color: BRAND_GREY,
              alignment: 'right',
              margin: [0, 2, 0, 0] as [number, number, number, number],
            },
          ],
        },
      ],
    });
  }

  content.push(signaturesBlock(input));

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [42, 42, 42, 42],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    info: {
      title: `Акт работ ${input.ticket.ticketNumber}`,
      author: input.tenant.legalName,
      subject: 'Акт выполненных работ',
    },
    content,
  };
}
