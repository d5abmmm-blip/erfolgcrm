/**
 * Shared types for PDF templates of ErfolgCRM v2.
 * All amounts are stored in kopecks (integer) and converted to roubles for display.
 */

export interface TenantData {
  legalName: string;
  displayName: string;
  slogan: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  bankAccount: string | null;
  correspondentAccount: string | null;
  bik: string | null;
  licenseSeries: string | null;
  licenseNumber: string | null;
  /** ISO date string */
  licenseDate: string | null;
  licenseAuthority: string | null;
  /** ФИО директора (для подписи) */
  director: string;
}

export interface ClientData {
  displayName: string;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  /** Рабочий телефон организации — для дефектного акта («Владелец оборудования»). */
  phone?: string | null;
  /** для актов — кого вписать как представителя клиента */
  contactName?: string | null;
  contactPosition?: string | null;
}

export interface AssetData {
  model: string;
  manufacturer: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  riskClass: '1' | '2a' | '2b' | '3' | null;
  /** ISO date ввода в эксплуатацию — для строки «Год выпуска/ввода» дефектного акта. */
  commissionedAt?: string | null;
}

export type RepairType = 'paid' | 'warranty' | 'service_contract';

export interface TicketData {
  ticketNumber: string;
  /** ISO date */
  receivedAt: string;
  repairType: RepairType;
  symptom: string | null;
  /** значение, кодируемое в Code-128 (обычно ticketNumber или внутренний UID) */
  barcode: string;
}

export type LineType = 'work' | 'part' | 'expense';
export type VatRate = '0' | '5' | '10' | '20' | 'without_vat';

export interface WorkOrderLine {
  lineType: LineType;
  name: string;
  unit: string;
  quantity: number;
  unitPriceKopecks: number;
  amountKopecks: number;
}

export interface WorkOrderData {
  vatRate: VatRate;
  worksAmountKopecks: number;
  partsAmountKopecks: number;
  expensesAmountKopecks: number;
  totalAmountKopecks: number;
  lines: WorkOrderLine[];
  diagnosis?: string | null;
  repairDescription?: string | null;
  recommendation?: string | null;
}

export interface PrintIntakeInput {
  tenant: TenantData;
  client: ClientData;
  asset: AssetData | null;
  ticket: TicketData;
}

export interface PrintInvoiceInput {
  tenant: TenantData;
  client: ClientData;
  ticket: TicketData;
  workOrder: WorkOrderData;
}

export interface PrintWorkActInput {
  tenant: TenantData;
  client: ClientData;
  asset: AssetData | null;
  ticket: TicketData;
  workOrder: WorkOrderData;
}

/* -------------------- formatting helpers -------------------- */

/** Convert integer kopecks to roubles (number). */
export function kopToRub(kop: number): number {
  return Math.round(kop) / 100;
}

const RUB_FMT = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format kopecks as "1 234,56 ₽". */
export function formatRub(kop: number): string {
  return `${RUB_FMT.format(kopToRub(kop))} ₽`;
}

/** Format kopecks as "1 234,56" without currency sign — for table cells. */
export function formatRubBare(kop: number): string {
  return RUB_FMT.format(kopToRub(kop));
}

/** Format ISO date string as "дд.мм.гггг". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU');
}

/** Pretty VAT rate label for display. */
export function vatRateLabel(rate: VatRate): string {
  switch (rate) {
    case 'without_vat':
      return 'Без НДС';
    case '0':
      return '0%';
    case '5':
      return '5%';
    case '10':
      return '10%';
    case '20':
      return '20%';
  }
}

/** Numeric VAT percentage (0 for without_vat). */
export function vatRatePercent(rate: VatRate): number {
  if (rate === 'without_vat') return 0;
  return Number(rate);
}

export function repairTypeLabel(t: RepairType): string {
  switch (t) {
    case 'paid':
      return 'Платный';
    case 'warranty':
      return 'Гарантийный';
    case 'service_contract':
      return 'По договору';
  }
}

export function riskClassLabel(rc: AssetData['riskClass']): string {
  return rc ? `Класс ${rc}` : '—';
}
