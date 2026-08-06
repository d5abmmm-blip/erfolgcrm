/**
 * Минимальный генератор CommerceML 2 XML для выгрузки счетов в 1С.
 *
 * Документация: http://v8.1c.ru/edi/edi_stnd/131/
 *
 * Генерируем «Документ.СчётНаОплатуПокупателю» — самая распространённая форма.
 * Для медтехники не используем «Реализация товаров и услуг» (потребуется акт).
 *
 * Формат уровня MVP: позволяет 1С:Бухгалтерия 8.3 импортировать счёт через
 * стандартную обработку «Загрузка из CommerceML». Полная совместимость с EDI/УПД —
 * отдельная задача (после первого пилотного импорта в 1С реального клиента).
 *
 * Безопасность XML: все user-supplied значения проходят escapeXml.
 */

export interface OnecCounterparty {
  /** Стабильный идентификатор контрагента (используем UUID клиента). */
  id: string;
  /** Полное наименование. */
  name: string;
  inn?: string | null;
  kpp?: string | null;
  legalAddress?: string | null;
}

export interface OnecLineItem {
  id: string; // line.id
  name: string;
  unit: string;
  quantity: string; // numeric '1.500'
  /** Цена за единицу В РУБЛЯХ (не копейки) — для 1С привычнее. */
  pricePerUnit: number;
  /** Итого по строке В РУБЛЯХ. */
  totalAmount: number;
  vatRate: '0' | '5' | '10' | '20' | 'without_vat';
  vatAmount: number;
}

export interface OnecInvoiceDoc {
  /** UUID invoice.id — стабильный 1C ID. */
  id: string;
  /** Номер вида INV-2026-000017. */
  number: string;
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  totalAmount: number;
  vatAmount: number;
  vatRate: '0' | '5' | '10' | '20' | 'without_vat';
  /** Поставщик — это сам tenant. */
  supplier: OnecCounterparty;
  /** Покупатель — клиент (заказчик). */
  buyer: OnecCounterparty;
  lines: OnecLineItem[];
  /** Опциональное примечание. */
  notes?: string | null;
}

export interface BuildExportInput {
  /** Идентификатор пакета: tenant_subdomain + timestamp. */
  packageId: string;
  /** Дата формирования пакета (ISO). */
  generatedAt: string;
  documents: OnecInvoiceDoc[];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function num(n: number): string {
  // 1С ожидает «.» (не «,») как разделитель.
  return n.toFixed(2);
}

function vatRateLabel(r: OnecLineItem['vatRate']): string {
  if (r === 'without_vat') return 'Без НДС';
  return `${r}%`;
}

function counterpartyXml(
  role: 'Поставщик' | 'Покупатель',
  c: OnecCounterparty,
  indent = '      ',
): string {
  const lines = [
    `${indent}<Контрагент>`,
    `${indent}  <Ид>${escapeXml(c.id)}</Ид>`,
    `${indent}  <Наименование>${escapeXml(c.name)}</Наименование>`,
  ];
  if (c.inn) lines.push(`${indent}  <ИНН>${escapeXml(c.inn)}</ИНН>`);
  if (c.kpp) lines.push(`${indent}  <КПП>${escapeXml(c.kpp)}</КПП>`);
  if (c.legalAddress) {
    lines.push(`${indent}  <АдресРегистрации>${escapeXml(c.legalAddress)}</АдресРегистрации>`);
  }
  lines.push(`${indent}  <Роль>${role}</Роль>`);
  lines.push(`${indent}</Контрагент>`);
  return lines.join('\n');
}

function lineItemXml(line: OnecLineItem, indent = '      '): string {
  return [
    `${indent}<Товар>`,
    `${indent}  <Ид>${escapeXml(line.id)}</Ид>`,
    `${indent}  <Наименование>${escapeXml(line.name)}</Наименование>`,
    `${indent}  <БазоваяЕдиница Код="796" НаименованиеПолное="${escapeXml(line.unit)}">${escapeXml(line.unit)}</БазоваяЕдиница>`,
    `${indent}  <ЦенаЗаЕдиницу>${num(line.pricePerUnit)}</ЦенаЗаЕдиницу>`,
    `${indent}  <Количество>${escapeXml(line.quantity)}</Количество>`,
    `${indent}  <Сумма>${num(line.totalAmount)}</Сумма>`,
    `${indent}  <СтавкаНДС>${vatRateLabel(line.vatRate)}</СтавкаНДС>`,
    `${indent}  <СуммаНДС>${num(line.vatAmount)}</СуммаНДС>`,
    `${indent}</Товар>`,
  ].join('\n');
}

function documentXml(doc: OnecInvoiceDoc): string {
  const lines: string[] = [];
  lines.push('  <Документ>');
  lines.push(`    <Ид>${escapeXml(doc.id)}</Ид>`);
  lines.push(`    <Номер>${escapeXml(doc.number)}</Номер>`);
  lines.push(`    <Дата>${escapeXml(doc.date)}</Дата>`);
  lines.push('    <ХозОперация>Заказ товаров</ХозОперация>');
  lines.push('    <Роль>Продавец</Роль>');
  lines.push(`    <Валюта>RUB</Валюта>`);
  lines.push(`    <Курс>1</Курс>`);
  lines.push(`    <Сумма>${num(doc.totalAmount)}</Сумма>`);
  lines.push(`    <СуммаНДС>${num(doc.vatAmount)}</СуммаНДС>`);
  lines.push(`    <СтавкаНДС>${vatRateLabel(doc.vatRate)}</СтавкаНДС>`);
  if (doc.notes) {
    lines.push(`    <Комментарий>${escapeXml(doc.notes)}</Комментарий>`);
  }
  lines.push('    <Контрагенты>');
  lines.push(counterpartyXml('Поставщик', doc.supplier));
  lines.push(counterpartyXml('Покупатель', doc.buyer));
  lines.push('    </Контрагенты>');
  lines.push('    <Товары>');
  for (const line of doc.lines) {
    lines.push(lineItemXml(line));
  }
  lines.push('    </Товары>');
  lines.push('  </Документ>');
  return lines.join('\n');
}

export function buildCommerceMlExport(input: BuildExportInput): string {
  const docs = input.documents.map((d) => documentXml(d)).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<КоммерческаяИнформация ВерсияСхемы="2.05" ДатаФормирования="' +
      escapeXml(input.generatedAt) +
      '">',
    '  <ИдПакета>' + escapeXml(input.packageId) + '</ИдПакета>',
    docs,
    '</КоммерческаяИнформация>',
  ].join('\n');
}

/**
 * Парсер входящего batch-payment-records (формат JSON, не XML — для простоты MVP).
 * Структура:
 *   { payments: [{ invoiceExternalId | invoiceNumber, amountKopecks, paidAt, method, comment }] }
 *
 * Где invoiceExternalId — это invoice.id (UUID), либо invoice.invoiceNumber.
 */
export interface IncomingPaymentRecord {
  invoiceExternalId?: string;
  invoiceNumber?: string;
  /**
   * Идентификатор платежа в 1С (UUID документа / внешний номер). Используется как ключ
   * идемпотентности при импорте: повторный webhook с тем же externalPaymentId не
   * создаст дубль (см. payments.external_payment_id + UNIQUE индекс).
   */
  externalPaymentId?: string;
  amountKopecks: string | number;
  paidAt: string; // ISO
  method: 'cash' | 'card' | 'bank_transfer';
  comment?: string;
}

export function parseIncomingPayments(body: unknown): IncomingPaymentRecord[] {
  if (!body || typeof body !== 'object') {
    throw new Error('payload must be JSON object with "payments" array');
  }
  const payments = (body as { payments?: unknown }).payments;
  if (!Array.isArray(payments)) {
    throw new Error('payload.payments must be an array');
  }
  return payments.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`payments[${idx}] must be object`);
    }
    const r = raw as Record<string, unknown>;
    const externalId = typeof r.invoiceExternalId === 'string' ? r.invoiceExternalId : undefined;
    const invoiceNumber = typeof r.invoiceNumber === 'string' ? r.invoiceNumber : undefined;
    if (!externalId && !invoiceNumber) {
      throw new Error(`payments[${idx}]: invoiceExternalId or invoiceNumber required`);
    }
    const amountKopecks = r.amountKopecks;
    if (typeof amountKopecks !== 'string' && typeof amountKopecks !== 'number') {
      throw new Error(`payments[${idx}]: amountKopecks required (string|number)`);
    }
    if (typeof r.paidAt !== 'string') {
      throw new Error(`payments[${idx}]: paidAt required (ISO string)`);
    }
    if (!['cash', 'card', 'bank_transfer'].includes(r.method as string)) {
      throw new Error(`payments[${idx}]: method must be cash|card|bank_transfer`);
    }
    const externalPaymentId =
      typeof r.externalPaymentId === 'string' ? r.externalPaymentId : undefined;
    return {
      invoiceExternalId: externalId,
      invoiceNumber,
      externalPaymentId,
      amountKopecks,
      paidAt: r.paidAt,
      method: r.method as 'cash' | 'card' | 'bank_transfer',
      comment: typeof r.comment === 'string' ? r.comment : undefined,
    };
  });
}
