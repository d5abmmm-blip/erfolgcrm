/**
 * Этап 6 — ярлык на технику 58×40 мм (термопринтер DYMO/Brother).
 *
 * Содержимое:
 *   - Линия бренда сверху (BRAND_PRIMARY).
 *   - Модель + производитель + S/N + инвентарный № (компактно).
 *   - Code-128 штрих-код по ticket.barcode либо asset.id.
 *   - Номер заявки и дата приёма (если ярлык печатается в момент оформления).
 */
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { BRAND_PRIMARY, BRAND_GREY } from './branding';
import { formatDate, type AssetData, type TicketData } from './shared';

export interface PrintAssetLabelInput {
  asset: AssetData;
  /** Опционально: показать номер и штрих-код заявки. Если null — кодируется asset.id. */
  ticket: Pick<TicketData, 'ticketNumber' | 'receivedAt' | 'barcode'> | null;
  /** Уникальный ID для штрих-кода когда нет ticket'а — обычно asset.id (UUID). */
  fallbackBarcode: string;
  /** Имя/слоган центра — печатается мелким шрифтом сверху. */
  tenantDisplayName: string;
}

interface BuildLabelInput extends PrintAssetLabelInput {
  /** PNG data URL штрих-кода (или пустая строка, если генерация упала). */
  barcodeDataUrl: string;
}

const MM = 2.834645669; // pdfmake unit = pt; 1mm ≈ 2.83465pt

function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function buildAssetLabelDoc(input: BuildLabelInput): TDocumentDefinitions {
  const a = input.asset;
  const t = input.ticket;
  const lines: Content[] = [
    {
      text: clipText(input.tenantDisplayName, 28),
      fontSize: 6,
      color: BRAND_GREY,
      alignment: 'center',
    },
    {
      canvas: [
        {
          type: 'line',
          x1: 0,
          y1: 1,
          x2: 54 * MM,
          y2: 1,
          lineWidth: 0.6,
          lineColor: BRAND_PRIMARY,
        },
      ],
      margin: [0, 1, 0, 2],
    },
    {
      text: clipText(a.model, 30),
      fontSize: 9,
      bold: true,
      alignment: 'center',
    },
    {
      // Инвентарный номер печатаем рядом с серийником: у бюджетников он часто
      // единственный, и без него ярлык выходил вообще без номера аппарата.
      text: clipText(
        [
          a.manufacturer,
          a.serialNumber ? `s/n ${a.serialNumber}` : null,
          a.inventoryNumber ? `инв. ${a.inventoryNumber}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || ' ',
        38,
      ),
      fontSize: 7,
      color: BRAND_GREY,
      alignment: 'center',
      margin: [0, 1, 0, 2],
    },
  ];

  if (input.barcodeDataUrl) {
    lines.push({
      image: input.barcodeDataUrl,
      width: 50 * MM,
      alignment: 'center',
    });
  }

  if (t) {
    lines.push({
      text: `№ ${t.ticketNumber} · ${formatDate(t.receivedAt)}`,
      fontSize: 6,
      color: BRAND_GREY,
      alignment: 'center',
      margin: [0, 1, 0, 0],
    });
  } else {
    lines.push({
      text: clipText(input.fallbackBarcode, 26),
      fontSize: 5,
      color: BRAND_GREY,
      alignment: 'center',
      margin: [0, 1, 0, 0],
    });
  }

  return {
    pageSize: { width: 58 * MM, height: 40 * MM },
    pageOrientation: 'portrait',
    pageMargins: [2 * MM, 2 * MM, 2 * MM, 2 * MM],
    defaultStyle: { font: 'Roboto', fontSize: 7 },
    info: {
      title: `Ярлык ${t?.ticketNumber ?? a.serialNumber ?? input.fallbackBarcode}`,
      subject: 'Ярлык на технику',
    },
    content: lines,
  };
}
