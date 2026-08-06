/**
 * Builder for "Акт технического состояния" (Technical Condition Act).
 *
 * Отдельный «полевой» документ: инженер печатает его со своего телефона на месте.
 * В отличие от «Дефектного акта» — это НЕ смета: без таблицы работ/запчастей и цен.
 * Фиксирует владельца и оборудование, повод осмотра, результат технического осмотра,
 * чек-лист годности к эксплуатации (отмечается вручную), рекомендации и подписи.
 *
 * Наряд необязателен: если он есть — «Результат осмотра» берётся из diagnosis, а
 * «Рекомендации» — из recommendation; если наряда нет — эти разделы печатаются
 * пустыми линиями под заполнение от руки. Фирменная шапка — как у остальных актов.
 */

import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import { BRAND_GREY, BRAND_LIGHT_GREY, BRAND_PRIMARY } from './branding';
import {
  type AssetData,
  type ClientData,
  type TenantData,
  type TicketData,
  type WorkOrderData,
  formatDate,
  riskClassLabel,
} from './shared';

export interface PrintTechConditionActInput {
  tenant: TenantData;
  client: ClientData;
  asset: AssetData | null;
  ticket: TicketData;
  /**
   * Наряд — опционален. Без него разделы осмотра/рекомендаций печатаются пустыми
   * (для заполнения от руки в поле). С нарядом — подставляются diagnosis/recommendation.
   */
  workOrder?: WorkOrderData | null;
  /** PNG data URL штрихкода или пустая строка. */
  barcodeDataUrl: string;
  /** Номер акта; по умолчанию — номер заявки. */
  actNumber?: string;
  /** Дата акта ISO; по умолчанию — ticket.receivedAt. */
  issuedAt?: string;
  /** ФИО инженера для строки «Осмотр произвёл». Пусто — только линия для подписи. */
  executorName?: string | null;
}

function headerBlock(input: PrintTechConditionActInput): Content {
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

/** Строка-определение «Метка: значение». */
function fieldRow(label: string, value: string): Content {
  return {
    columns: [
      { width: 160, text: label, fontSize: 10, color: BRAND_GREY },
      { width: '*', text: value || '—', fontSize: 10 },
    ],
    columnGap: 8,
    margin: [0, 2, 0, 0],
  };
}

function ownerBlock(input: PrintTechConditionActInput): Content {
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
  if (a?.riskClass) rows.push(fieldRow('Класс риска:', riskClassLabel(a.riskClass)));
  rows.push(fieldRow('Повод осмотра:', input.ticket.symptom ?? ''));

  return { margin: [0, 12, 0, 0], stack: rows };
}

/** Пустая линия под заполнение от руки. */
function blankLine(): Content {
  return {
    canvas: [
      { type: 'line', x1: 0, y1: 8, x2: 511, y2: 8, lineWidth: 0.5, lineColor: BRAND_LIGHT_GREY },
    ],
    margin: [0, 8, 0, 0],
  };
}

/**
 * Раздел «Заголовок + текст». Если текста нет — вместо него `blankCount` пустых
 * линий под заполнение от руки (для печати без наряда прямо в поле).
 */
function sectionOrBlank(
  title: string,
  body: string | null | undefined,
  blankCount: number,
): Content {
  const text = (body ?? '').trim();
  const stack: Content[] = [{ text: title, bold: true, fontSize: 10, color: BRAND_GREY }];
  if (text) {
    stack.push({ text, fontSize: 10, margin: [0, 2, 0, 0] as [number, number, number, number] });
  } else {
    for (let i = 0; i < blankCount; i++) stack.push(blankLine());
  }
  return { margin: [0, 12, 0, 0], stack };
}

/** Пункт чек-листа: пустой квадрат + подпись (отмечается вручную). */
function checkboxRow(label: string): Content {
  return {
    columns: [
      {
        width: 14,
        canvas: [{ type: 'rect', x: 0, y: 1, w: 9, h: 9, lineWidth: 0.8, lineColor: BRAND_GREY }],
      },
      { width: '*', text: label, fontSize: 10 },
    ],
    columnGap: 2,
    margin: [0, 4, 0, 0],
  };
}

function verdictBlock(): Content {
  return {
    margin: [0, 12, 0, 0],
    stack: [
      { text: 'Заключение о техническом состоянии:', bold: true, fontSize: 10, color: BRAND_GREY },
      checkboxRow('Исправно, годно к эксплуатации'),
      checkboxRow('Годно к эксплуатации с ограничениями'),
      checkboxRow('Неисправно, требуется ремонт'),
      checkboxRow('Рекомендовано к списанию'),
    ],
  };
}

function signaturesBlock(input: PrintTechConditionActInput): Content {
  const clientName = input.client.contactName?.trim() || input.client.displayName;
  return {
    margin: [0, 26, 0, 0],
    columns: [
      {
        width: '*',
        stack: [
          {
            text: [
              { text: 'Осмотр произвёл: ', fontSize: 10 },
              { text: '_________________________', fontSize: 10 },
            ],
          },
          {
            text: input.executorName?.trim() || input.tenant.director || '',
            fontSize: 9,
            color: BRAND_GREY,
            margin: [90, 2, 0, 0] as [number, number, number, number],
          },
          {
            text: 'инженер',
            fontSize: 8,
            color: BRAND_GREY,
            margin: [90, 1, 0, 0] as [number, number, number, number],
          },
        ],
      },
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

export function buildTechConditionActDoc(input: PrintTechConditionActInput): TDocumentDefinitions {
  const number = input.actNumber ?? input.ticket.ticketNumber;
  const issueDate = input.issuedAt ?? input.ticket.receivedAt;

  const content: Content[] = [
    headerBlock(input),
    {
      canvas: [
        { type: 'line', x1: 0, y1: 4, x2: 515, y2: 4, lineWidth: 1, lineColor: BRAND_PRIMARY },
      ],
      margin: [0, 6, 0, 0],
    },
    {
      text: `АКТ ТЕХНИЧЕСКОГО СОСТОЯНИЯ № ${number} от ${formatDate(issueDate)}`,
      bold: true,
      fontSize: 13,
      color: BRAND_PRIMARY,
      alignment: 'center',
      margin: [0, 14, 0, 0],
    },
    ownerBlock(input),
    sectionOrBlank('Результат технического осмотра:', input.workOrder?.diagnosis, 3),
    verdictBlock(),
    sectionOrBlank('Рекомендации:', input.workOrder?.recommendation, 2),
  ];

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
      title: `Акт технического состояния ${number}`,
      author: input.tenant.legalName,
      subject: 'Акт технического состояния',
    },
    content,
  };
}
