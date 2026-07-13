/**
 * Builder for "Акт приёма оборудования" (Intake Act).
 * Returns a pdfmake TDocumentDefinitions ready to render.
 */

import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import { BRAND_PRIMARY, BRAND_GREY, BRAND_LIGHT_GREY } from './branding';
import {
  type PrintIntakeInput,
  formatDate,
  repairTypeLabel,
  riskClassLabel,
} from './shared';

interface BuildIntakeActInput extends PrintIntakeInput {
  /** PNG data URL, or empty string when generation failed. */
  barcodeDataUrl: string;
}

const INTAKE_TERMS: string[] = [
  'Заказчик гарантирует, что является собственником оборудования и имеет право на его передачу для ремонта.',
  'Диагностика выполняется в течение 3 рабочих дней. По результатам формируется дефектный акт и смета.',
  'До согласования сметы работы не выполняются. Заказчик вправе отказаться, оплатив только диагностику.',
  'Гарантия предоставляется только на установленные запасные части — 6 месяцев со дня подписания акта работ. На выполненные работы (ремонт) гарантия не предоставляется.',
  'Гарантия не распространяется на повреждения от попадания жидкости, удара, скачков напряжения.',
  'Хранение оборудования после готовности — бесплатно 14 календарных дней. Далее — 50 ₽/сутки.',
  'Невостребованное более 90 дней оборудование может быть реализовано в счёт хранения (ст. 359 ГК РФ).',
  'Подписывая акт, заказчик подтверждает осведомлённость с условиями и согласие с ними.',
];

/** Renders a checkbox label like "☑ Платный  ☐ Гарантийный  ☐ По договору". */
function repairTypeRow(active: PrintIntakeInput['ticket']['repairType']): {
  columns: Content[];
  columnGap: number;
} {
  const variants: { key: PrintIntakeInput['ticket']['repairType']; label: string }[] = [
    { key: 'paid', label: 'Платный' },
    { key: 'warranty', label: 'Гарантийный' },
    { key: 'service_contract', label: 'По договору' },
  ];
  const cells: Content[] = variants.map((v) => ({
    text: `${active === v.key ? '☑' : '☐'} ${v.label}`,
    margin: [0, 0, 16, 0] as [number, number, number, number],
  }));
  return { columns: cells, columnGap: 4 };
}

function tenantRequisitesLines(input: BuildIntakeActInput): string[] {
  const t = input.tenant;
  const lines: string[] = [];
  if (t.inn) lines.push(`ИНН ${t.inn}${t.kpp ? ` / КПП ${t.kpp}` : ''}`);
  if (t.ogrn) lines.push(`ОГРН ${t.ogrn}`);
  if (t.legalAddress) lines.push(t.legalAddress);
  if (t.phone) lines.push(`Тел.: ${t.phone}`);
  if (t.email) lines.push(`E-mail: ${t.email}`);
  if (t.licenseSeries && t.licenseNumber) {
    lines.push(
      `Лицензия ${t.licenseSeries} № ${t.licenseNumber}${
        t.licenseDate ? ` от ${formatDate(t.licenseDate)}` : ''
      }${t.licenseAuthority ? `, ${t.licenseAuthority}` : ''}`,
    );
  }
  return lines;
}

function headerBlock(input: BuildIntakeActInput): Content {
  return {
    columns: [
      {
        width: '*',
        stack: [
          {
            text: input.tenant.displayName || 'ERFOLG',
            fontSize: 22,
            bold: true,
            color: BRAND_PRIMARY,
          },
          ...(input.tenant.slogan
            ? [{ text: input.tenant.slogan, fontSize: 9, color: BRAND_GREY, margin: [0, 2, 0, 0] as [number, number, number, number] }]
            : []),
          { text: input.tenant.legalName, fontSize: 9, margin: [0, 4, 0, 0] as [number, number, number, number] },
        ],
      },
      {
        width: '*',
        alignment: 'right',
        stack: tenantRequisitesLines(input).map((l) => ({
          text: l,
          fontSize: 8,
          color: BRAND_GREY,
        })),
      },
    ],
  };
}

function partiesBlock(input: BuildIntakeActInput): Content {
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
          ...(t.legalAddress
            ? [{ text: t.legalAddress, fontSize: 9 }]
            : []),
        ],
      },
      {
        width: '*',
        stack: [
          { text: 'Заказчик:', bold: true, fontSize: 10 },
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

function assetTable(input: BuildIntakeActInput): Content {
  const a = input.asset;
  const headerCell = (text: string): Content => ({
    text,
    bold: true,
    color: 'white',
    fillColor: BRAND_PRIMARY,
    fontSize: 9,
    margin: [4, 4, 4, 4],
  });
  const cell = (text: string): Content => ({
    text,
    fontSize: 9,
    margin: [4, 4, 4, 4],
  });
  return {
    margin: [0, 12, 0, 0],
    table: {
      widths: ['*', '*', 'auto', 'auto', 'auto'],
      headerRows: 1,
      body: [
        [
          headerCell('Модель'),
          headerCell('Производитель'),
          headerCell('Серийный №'),
          headerCell('Инв. №'),
          headerCell('Класс риска'),
        ],
        [
          cell(a?.model ?? '—'),
          cell(a?.manufacturer ?? '—'),
          cell(a?.serialNumber ?? '—'),
          cell(a?.inventoryNumber ?? '—'),
          cell(riskClassLabel(a?.riskClass ?? null)),
        ],
      ],
    },
    layout: {
      hLineColor: () => BRAND_LIGHT_GREY,
      vLineColor: () => BRAND_LIGHT_GREY,
    },
  };
}

function symptomBlock(input: BuildIntakeActInput): Content {
  return {
    margin: [0, 10, 0, 0],
    stack: [
      { text: 'Заявленная неисправность (со слов клиента):', bold: true, fontSize: 10 },
      {
        text: input.ticket.symptom?.trim() || '—',
        fontSize: 10,
        margin: [0, 2, 0, 0] as [number, number, number, number],
      },
    ],
  };
}

function termsBlock(): Content {
  return {
    margin: [0, 12, 0, 0],
    stack: [
      { text: 'Условия приёма', bold: true, color: BRAND_PRIMARY, fontSize: 11 },
      {
        margin: [0, 4, 0, 0],
        ol: INTAKE_TERMS.map((t) => ({ text: t, fontSize: 9 })),
      },
    ],
  };
}

function signaturesBlock(input: BuildIntakeActInput): Content {
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
            text: input.tenant.director || 'Директор',
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

export function buildIntakeActDoc(input: BuildIntakeActInput): TDocumentDefinitions {
  const dateStr = formatDate(input.ticket.receivedAt);
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
      text: `АКТ ПРИЁМА ОБОРУДОВАНИЯ № ${input.ticket.ticketNumber}`,
      bold: true,
      fontSize: 14,
      color: BRAND_PRIMARY,
      alignment: 'center',
      margin: [0, 14, 0, 0],
    },
    {
      text: `Дата приёма: ${dateStr}`,
      alignment: 'center',
      fontSize: 10,
      margin: [0, 2, 0, 0],
    },
    partiesBlock(input),
    {
      margin: [0, 12, 0, 0],
      stack: [
        { text: 'Тип ремонта:', bold: true, fontSize: 10 },
        {
          margin: [0, 4, 0, 0],
          ...repairTypeRow(input.ticket.repairType),
        },
      ],
    },
    {
      text: `Вариант: ${repairTypeLabel(input.ticket.repairType)}`,
      fontSize: 9,
      color: BRAND_GREY,
      margin: [0, 2, 0, 0],
    },
    assetTable(input),
    symptomBlock(input),
    termsBlock(),
  ];

  if (input.barcodeDataUrl) {
    content.push({
      margin: [0, 14, 0, 0],
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
    // pdfmake uses points; 40mm ≈ 113pt, 15mm ≈ 42pt
    pageMargins: [42, 42, 42, 42],
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    info: {
      title: `Акт приёма ${input.ticket.ticketNumber}`,
      author: input.tenant.legalName,
      subject: 'Акт приёма оборудования в ремонт',
    },
    content,
  };
}
