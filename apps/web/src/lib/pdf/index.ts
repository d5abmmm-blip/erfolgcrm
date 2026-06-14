/**
 * Public API for ErfolgCRM PDF templates.
 * Each printer builds a pdfmake document and opens it in a new browser tab.
 *
 * Usage:
 *   await printIntakeAct({ tenant, client, asset, ticket });
 *   await printInvoice({ tenant, client, ticket, workOrder });
 *   await printWorkAct({ tenant, client, asset, ticket, workOrder });
 */

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type * as pdfMakeNs from 'pdfmake/build/pdfmake';

import { generateBarcodeDataUrl } from './barcode';
import { buildAssetLabelDoc, type PrintAssetLabelInput } from './asset-label';
import { buildContractDoc, type PrintContractInput } from './contract';
import { buildDailySummaryDoc, type DailySummaryInput } from './daily-summary';
import { buildDefectActDoc, type PrintDefectActInput } from './defect-act';
import { buildIntakeActDoc } from './intake-act';
import { buildInvoiceDoc, type ExtendedPrintInvoiceInput } from './invoice';
import type {
  PrintIntakeInput,
  PrintWorkActInput,
} from './shared';
import { buildWorkActDoc } from './work-act';

// pdfmake's vfs ships under different shapes depending on the bundle path,
// so we accept both the legacy `.pdfMake.vfs` and the modern `.vfs` layouts.
type PdfFontsModule = { pdfMake?: { vfs: Record<string, string> }; vfs?: Record<string, string> };

/**
 * Lazy-loader: pdfmake (~1.5MB) и vfs_fonts (~600KB) подгружаются только при
 * первом вызове любой printXxx(). До этого момента в главном бандле их нет.
 *
 * @types/pdfmake публикует API через named exports (без default), но runtime-бандл
 * (UMD) даёт ESM default через esModuleInterop. Используем alias импорт типов
 * + cast .default к нему.
 */
type PdfMakeRuntime = typeof pdfMakeNs;
let _pdfMakePromise: Promise<PdfMakeRuntime> | null = null;
async function getPdfMake(): Promise<PdfMakeRuntime> {
  if (_pdfMakePromise) return _pdfMakePromise;
  _pdfMakePromise = (async () => {
    const [pdfMakeMod, fontsMod] = await Promise.all([
      import('pdfmake/build/pdfmake'),
      import('pdfmake/build/vfs_fonts'),
    ]);
    // Runtime-бандл pdfmake публикует createPdf и vfs либо в module.default
    // (esModuleInterop), либо прямо в namespace — берём первое непустое.
    const modAny = pdfMakeMod as unknown as { default?: PdfMakeRuntime } & PdfMakeRuntime;
    const pdfMake: PdfMakeRuntime = (modAny.default ?? modAny);
    const fontsAny = fontsMod as unknown as { default?: PdfFontsModule } & PdfFontsModule;
    const vfsRoot = fontsAny.default ?? fontsAny;
    (pdfMake as unknown as { vfs: Record<string, string> }).vfs =
      vfsRoot.pdfMake?.vfs ?? vfsRoot.vfs ?? {};
    return pdfMake;
  })();
  return _pdfMakePromise;
}

/** Open a pdfmake document in a new browser tab. */
async function openDoc(doc: TDocumentDefinitions): Promise<void> {
  const pdfMake = await getPdfMake();
  pdfMake.createPdf(doc).open();
}

/**
 * Build a pdfmake document and return it as base64 (без data:-префикса) —
 * для вложения в письмо (раздел «Почта»). Та же сборка doc, что и у printXxx,
 * но вместо открытия вкладки отдаём байты.
 */
async function getDocAsBase64(doc: TDocumentDefinitions): Promise<string> {
  const pdfMake = await getPdfMake();
  return new Promise<string>((resolve) => {
    pdfMake.createPdf(doc).getBase64((data: string) => resolve(data));
  });
}

export async function getIntakeActAsBase64(input: PrintIntakeInput): Promise<string> {
  const barcodeDataUrl = await generateBarcodeDataUrl(input.ticket.barcode);
  return getDocAsBase64(buildIntakeActDoc({ ...input, barcodeDataUrl }));
}

export async function getInvoiceAsBase64(input: ExtendedPrintInvoiceInput): Promise<string> {
  return getDocAsBase64(buildInvoiceDoc(input));
}

export async function getWorkActAsBase64(input: PrintWorkActInput): Promise<string> {
  const barcodeDataUrl = await generateBarcodeDataUrl(input.ticket.barcode);
  return getDocAsBase64(buildWorkActDoc({ ...input, barcodeDataUrl }));
}

export async function getDefectActAsBase64(
  input: Omit<PrintDefectActInput, 'barcodeDataUrl'>,
): Promise<string> {
  const barcodeDataUrl = await generateBarcodeDataUrl(input.ticket.barcode);
  return getDocAsBase64(buildDefectActDoc({ ...input, barcodeDataUrl }));
}

export async function printIntakeAct(input: PrintIntakeInput): Promise<void> {
  const barcodeDataUrl = await generateBarcodeDataUrl(input.ticket.barcode);
  const doc = buildIntakeActDoc({ ...input, barcodeDataUrl });
  await openDoc(doc);
}

export async function printInvoice(input: ExtendedPrintInvoiceInput): Promise<void> {
  // Invoice has no barcode requirement.
  const doc = buildInvoiceDoc(input);
  await openDoc(doc);
}

export async function printWorkAct(input: PrintWorkActInput): Promise<void> {
  const barcodeDataUrl = await generateBarcodeDataUrl(input.ticket.barcode);
  const doc = buildWorkActDoc({ ...input, barcodeDataUrl });
  await openDoc(doc);
}

export async function printDefectAct(
  input: Omit<PrintDefectActInput, 'barcodeDataUrl'>,
): Promise<void> {
  const barcodeDataUrl = await generateBarcodeDataUrl(input.ticket.barcode);
  const doc = buildDefectActDoc({ ...input, barcodeDataUrl });
  await openDoc(doc);
}

export async function printContract(input: PrintContractInput): Promise<void> {
  const doc = buildContractDoc(input);
  await openDoc(doc);
}

export async function printDailySummary(input: DailySummaryInput): Promise<void> {
  const doc = buildDailySummaryDoc(input);
  await openDoc(doc);
}

export async function printAssetLabel(input: PrintAssetLabelInput): Promise<void> {
  const codeValue = input.ticket?.barcode ?? input.fallbackBarcode;
  const barcodeDataUrl = await generateBarcodeDataUrl(codeValue, {
    scale: 2,
    heightMm: 9,
    includeText: false,
  });
  const doc = buildAssetLabelDoc({ ...input, barcodeDataUrl });
  await openDoc(doc);
}

// Re-export shared types so call sites import from a single entry point.
export type {
  AssetData,
  ClientData,
  LineType,
  PrintIntakeInput,
  PrintInvoiceInput,
  PrintWorkActInput,
  RepairType,
  TenantData,
  TicketData,
  VatRate,
  WorkOrderData,
  WorkOrderLine,
} from './shared';
export type { PrintAssetLabelInput } from './asset-label';
export { buildContractDoc } from './contract';
export type { ContractData, ContractTerms, PrintContractInput } from './contract';
export { buildDefectActDoc } from './defect-act';
export type { PrintDefectActInput } from './defect-act';
export type { ExtendedPrintInvoiceInput } from './invoice';
export type { DailySummaryInput } from './daily-summary';
