/**
 * Builder for "Дефектный акт" (Defect Act).
 *
 * Технический документ: владелец и оборудование, причина обращения, выполненные
 * работы, заключение о причинах неисправности, таблица работ/комплектующих и
 * подписи. По образцу ООО «Эрфольг» № 183 (memory/project_real_documents.md),
 * но в фирменной шапке СРМ — единообразно с актом приёма/работ и счётом.
 *
 * Заключение («Рекомендовано к списанию» и т.п.) берётся из workOrder.recommendation,
 * причина — из ticket.symptom, выполненные работы — из diagnosis + repairDescription.
 */

import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';

import { BRAND_GREY, BRAND_LIGHT_GREY, BRAND_PRIMARY } from './branding';
import { type PrintWorkActInput, formatDate, formatRubBare } from './shared';

export interface PrintDefectActInput extends PrintWorkActInput {
  /** PNG data URL штрихкода или пустая строка. */
  barcodeDataUrl: string;
  /** Номер дефектного акта; по умолчанию — номер заявки. */
  actNumber?: string;
  /** Дата акта ISO; по умолчанию — ticket.receivedAt. */
  issuedAt?: string;
  /** ФИО исполнителя для строки «Работу выполнил». Пусто — только линия для подписи. */
  executorName?: string | null;
}

function headerBlock(input: PrintDefectActInput): Content {
  const t = input.tenant;
  const requisites: string[] = [];
  if (t.inn) requisites.push(`ИНН ${t.inn}${t.kpp ? ` / КПП ${t.kpp}` : ''}`);
  if (t.ogrn) requisites.push(`ОГРН ${t.ogrn}`);
  if (t.legalAddress) requisites.push(t.legalAddress);
  if (t.phone) requisites.push(`Тел.: ${t.phone}`);
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
        alignment: 'right',
        stack: requisites.map((l) => ({ text: l, fontSize: 8, color: BRAND_GREY })),
      },
    ],
  };
}

/** Строка-определение «Метка: значение» (как форма с подписями полей). */
function fieldRow(label: string, value: string): Content {
  return {
    columns: [
      { width: 150, text: label, fontSize: 10, color: BRAND_GREY },
      { width: '*', text: value || '—', fontSize: 10 },
    ],
    columnGap: 8,
    margin: [0, 2, 0, 0],
  };
}

function ownerBlock(input: PrintDefectActInput): Content {
  const c = input.client;
  const a = input.asset;
  const equipment = a
    ? [a.manufacturer, a.model, a.serialNumber ? `S/N: ${a.serialNumber}` : null]
        .filter(Boolean)
        .join('; ')
    : '—';
  const commissionedYear =
    a?.commissionedAt && !Number.isNaN(new Date(a.commissionedAt).getTime())
      ? String(new Date(a.commissionedAt).getFullYear())
      : '';

  const rows: Content[] = [fieldRow('Владелец оборудования:', c.displayName)];
  if (c.phone) rows.push(fieldRow('Телефон:', c.phone));
  if (c.legalAddress) rows.push(fieldRow('Адрес:', c.legalAddress));
  rows.push(fieldRow('Оборудование:', equipment));
  if (a?.inventoryNumber) rows.push(fieldRow('Инвентарный №:', a.inventoryNumber));
  rows.push(fieldRow('Год выпуска/ввода:', commissionedYear));
  rows.push(fieldRow('Причина обращения:', input.ticket.symptom ?? ''));

  return { margin: [0, 12, 0, 0], stack: rows };
}

/** Заголовок раздела + многострочный текст (переносы \n сохраняются pdfmake). */
function section(title: string, body: string | null | undefined): Content | null {
  const text = (body ?? '').trim();
  if (!text) return null;
  return {
    margin: [0, 10, 0, 0],
    stack: [
      { text: title, bold: true, fontSize: 10, color: BRAND_GREY },
      { text, fontSize: 10, margin: [0, 2, 0, 0] as [number, number, number, number] },
    ],
  };
}

function worksTable(input: PrintDefectActInput): Content {
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
      headerCell('Наименование работ и комплектующих'),
      headerCell('Ед.изм', 'center'),
      headerCell('Кол-во', 'right'),
      headerCell('Цена, ₽', 'right'),
      headerCell('Сумма, ₽', 'right'),
    ],
  ];

  const lines = input.workOrder.lines;
  if (lines.length === 0) {
    // Пустая строка под ручное заполнение, если позиции ещё не заведены.
    body.push([
      cell(' '),
      cell(' ', 'center'),
      cell(' ', 'right'),
      cell(' ', 'right'),
      cell(' ', 'right'),
    ]);
  } else {
    lines.forEach((line) => {
      body.push([
        cell(line.name),
        cell(line.unit, 'center'),
        cell(String(line.quantity), 'right'),
        cell(formatRubBare(line.unitPriceKopecks), 'right'),
        cell(formatRubBare(line.amountKopecks), 'right'),
      ]);
    });
  }

  body.push([
    {
      text: 'ИТОГО:',
      bold: true,
      fontSize: 9,
      alignment: 'right',
      margin: [4, 3, 4, 3],
      colSpan: 4,
    },
    {},
    {},
    {},
    {
      text: formatRubBare(input.workOrder.totalAmountKopecks),
      bold: true,
      fontSize: 9,
      alignment: 'right',
      margin: [4, 3, 4, 3],
    },
  ]);

  return {
    margin: [0, 12, 0, 0],
    table: {
      headerRows: 1,
      widths: ['*', 44, 44, 70, 80],
      body,
    },
    layout: {
      hLineColor: () => BRAND_LIGHT_GREY,
      vLineColor: () => BRAND_LIGHT_GREY,
    },
  };
}

function signaturesBlock(input: PrintDefectActInput): Content {
  const clientName = input.client.contactName?.trim() || input.client.displayName;
  return {
    margin: [0, 26, 0, 0],
    columns: [
      {
        width: '*',
        stack: [
          {
            text: [
              { text: 'С актом ознакомлен(а): ', fontSize: 10 },
              { text: '_________________________', fontSize: 10 },
            ],
          },
          {
            text: clientName,
            fontSize: 9,
            color: BRAND_GREY,
            margin: [120, 2, 0, 0] as [number, number, number, number],
          },
        ],
      },
      {
        width: '*',
        stack: [
          {
            text: [
              { text: 'Работу выполнил: ', fontSize: 10 },
              { text: '_________________________', fontSize: 10 },
            ],
          },
          {
            text: input.executorName?.trim() || input.tenant.director || '',
            fontSize: 9,
            color: BRAND_GREY,
            margin: [96, 2, 0, 0] as [number, number, number, number],
          },
          {
            text: 'М.П.',
            fontSize: 9,
            color: BRAND_GREY,
            margin: [0, 6, 0, 0] as [number, number, number, number],
          },
        ],
      },
    ],
    columnGap: 24,
  };
}

export function buildDefectActDoc(input: PrintDefectActInput): TDocumentDefinitions {
  const number = input.actNumber ?? input.ticket.ticketNumber;
  // Дата документа — день составления, не дата приёмки (см. work-act.ts).
  const issueDate = input.issuedAt ?? new Date().toISOString();

  const content: Content[] = [
    headerBlock(input),
    {
      canvas: [
        { type: 'line', x1: 0, y1: 4, x2: 515, y2: 4, lineWidth: 1, lineColor: BRAND_PRIMARY },
      ],
      margin: [0, 6, 0, 0],
    },
    {
      text: `ДЕФЕКТНЫЙ АКТ № ${number} от ${formatDate(issueDate)}`,
      bold: true,
      fontSize: 13,
      color: BRAND_PRIMARY,
      alignment: 'center',
      margin: [0, 14, 0, 0],
    },
    ownerBlock(input),
  ];

  const works = section(
    'Выполненные работы:',
    input.workOrder.repairDescription || input.workOrder.diagnosis,
  );
  if (works) content.push(works);

  const conclusion = section(
    'Заключение о причинах неисправности:',
    input.workOrder.recommendation,
  );
  if (conclusion) content.push(conclusion);

  content.push(worksTable(input));

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
      title: `Дефектный акт ${number}`,
      author: input.tenant.legalName,
      subject: 'Дефектный акт',
    },
    content,
  };
}
