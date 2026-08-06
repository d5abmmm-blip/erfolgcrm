/**
 * Service слой обмена с 1С (Этап 8.F).
 *
 * exportInvoicesToOnecCmd — генерирует CommerceML-XML для пунктов status != draft / без onec_synced_at.
 * receivePaymentsFromOnecCmd — батч insert платежей. Для каждой записи resolves invoice по
 * invoiceExternalId (UUID) либо по invoiceNumber. Возвращает { processed, errors }.
 * generateIncomingTokenCmd — генерирует одноразовый токен (32-байт hex), сохраняет SHA-256 хэш в config.
 *
 * Все операции пишут в onec_exchange_log + audit (директор-only).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { asc, eq } from 'drizzle-orm';
import {
  clients,
  getDb,
  invoices,
  tenants,
  withTenantTx,
  workOrderLines,
  type Db,
} from '@erfolg/db';
import {
  buildCommerceMlExport,
  parseIncomingPayments,
  type OnecCounterparty,
  type OnecInvoiceDoc,
  type OnecLineItem,
} from '../../lib/onec-xml';
import { logger } from '../../lib/logger';
import { writeAudit } from '../../lib/audit';
import { addPayment } from '../payments/repository';
import { countPendingOnecExport, listPendingOnecExport, markManyOnecSynced } from '../invoices';
import {
  completeExchange,
  findEnabledTokenHashByTenant,
  getConfig,
  startExchange,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

/** SHA-256 hex от input — для безопасного сравнения и сохранения. */
export function hashIncomingToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time check — защита от timing attacks. */
export function verifyIncomingToken(provided: string, storedHash: string): boolean {
  const a = Buffer.from(hashIncomingToken(provided), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function kopecksToRubNumber(kopecks: bigint): number {
  // 1С работает с дробной частью до копейки. Number safe для сумм <= ~9e15.
  return Number(kopecks) / 100;
}

interface TenantRequisites {
  legalName: string;
  inn: string | null;
  kpp: string | null;
  legalAddress: string | null;
}

async function loadTenantRequisites(db: Db, tenantId: string): Promise<TenantRequisites> {
  const rows = await db
    .select({
      displayName: tenants.displayName,
      legalName: tenants.legalName,
      inn: tenants.inn,
      kpp: tenants.kpp,
      legalAddress: tenants.legalAddress,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const row = rows[0];
  return {
    legalName: row?.legalName ?? row?.displayName ?? 'Неизвестно',
    inn: row?.inn ?? null,
    kpp: row?.kpp ?? null,
    legalAddress: row?.legalAddress ?? null,
  };
}

async function loadClientForOnec(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<OnecCounterparty> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: clients.id,
        displayName: clients.displayName,
        inn: clients.inn,
        kpp: clients.kpp,
        legalAddress: clients.legalAddress,
      })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { id: clientId, name: 'Неизвестный', inn: null, kpp: null, legalAddress: null };
    }
    return {
      id: row.id,
      name: row.displayName,
      inn: row.inn,
      kpp: row.kpp,
      legalAddress: row.legalAddress,
    };
  });
}

async function buildLinesForInvoice(
  db: Db,
  tenantId: string,
  workOrderId: string,
  vatRate: OnecLineItem['vatRate'],
): Promise<OnecLineItem[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: workOrderLines.id,
        name: workOrderLines.name,
        unit: workOrderLines.unit,
        quantity: workOrderLines.quantity,
        unitPriceKopecks: workOrderLines.unitPriceKopecks,
        amountKopecks: workOrderLines.amountKopecks,
      })
      .from(workOrderLines)
      .where(eq(workOrderLines.workOrderId, workOrderId))
      // Без явного порядка позиции в файле каждый раз разные — один и тот же
      // счёт давал бы разные XML.
      .orderBy(asc(workOrderLines.orderIdx));
    return rows.map((r) => {
      const total = kopecksToRubNumber(r.amountKopecks);
      // VAT по строке: пропорционально line.amount от общего vat ставки.
      let vatAmount = 0;
      if (vatRate !== 'without_vat' && vatRate !== '0') {
        const rate = Number(vatRate);
        vatAmount = Math.round(((total * rate) / (100 + rate)) * 100) / 100;
      }
      return {
        id: r.id,
        name: r.name,
        unit: r.unit,
        quantity: r.quantity,
        pricePerUnit: kopecksToRubNumber(r.unitPriceKopecks),
        totalAmount: total,
        vatRate,
        vatAmount,
      };
    });
  });
}

export interface ExportResult {
  exchangeId: string;
  xml: string;
  processedCount: number;
  errorCount: number;
  /** Сколько счетов ждало выгрузки ВСЕГО (может быть больше EXPORT_BATCH_LIMIT). */
  totalPending: number;
  /** Сколько осталось на следующий запуск. */
  remaining: number;
}

/**
 * Сколько счетов уходит за один запуск. Потолок намеренный: выгрузка делает
 * два запроса к базе на каждый счёт и отдаёт XML одной строкой в ответе.
 */
export const EXPORT_BATCH_LIMIT = 500;

/**
 * Генерирует CommerceML XML для ещё не синхронизированных счетов.
 *
 * Порядок операций важен: счета помечаются выгруженными ТОЛЬКО после того, как
 * XML успешно собран, и одним запросом. Отметку снять нечем — ни кнопки, ни
 * процедуры, ни скрипта во всём проекте нет, — поэтому пометить счета и не
 * отдать файл означает потерять их из очереди навсегда.
 */
export async function exportInvoicesToOnecCmd(ctx: CmdCtx): Promise<ExportResult> {
  // Проверяем ДО записи в журнал обменов: выключенный обмен не должен
  // оставлять следов. Смотрим только на флаг «включён» — входящий токен
  // нужен вебхуку приёма платежей, к выгрузке файла он отношения не имеет
  // (иначе «Отозвать токен» молча ломало бы экспорт).
  const config = await getConfig(ctx.db, ctx.tenant.id);
  if (!config?.enabled) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'Обмен с 1С выключен. Включите переключатель «Включить обмен с 1С» в начале страницы настроек и повторите выгрузку.',
    });
  }

  const exchange = await startExchange(ctx.db, ctx.tenant.id, {
    direction: 'export',
    kind: 'invoices_export',
  });
  try {
    const totalPending = await countPendingOnecExport(ctx.db, ctx.tenant.id);
    const pending = await listPendingOnecExport(ctx.db, ctx.tenant.id, EXPORT_BATCH_LIMIT);
    const supplier = await loadTenantRequisites(ctx.db, ctx.tenant.id);
    const supplierCp: OnecCounterparty = {
      id: ctx.tenant.id,
      name: supplier.legalName,
      inn: supplier.inn,
      kpp: supplier.kpp,
      legalAddress: supplier.legalAddress,
    };

    const docs: OnecInvoiceDoc[] = [];
    const errors: Array<{ id: string; message: string }> = [];
    const processedIds: string[] = [];

    for (const inv of pending) {
      try {
        const buyer = await loadClientForOnec(ctx.db, ctx.tenant.id, inv.clientId);
        const lines = await buildLinesForInvoice(
          ctx.db,
          ctx.tenant.id,
          inv.workOrderId,
          inv.vatRate,
        );
        docs.push({
          id: inv.id,
          number: inv.invoiceNumber,
          date: inv.issueDate,
          totalAmount: kopecksToRubNumber(BigInt(inv.totalAmountKopecks)),
          vatAmount: kopecksToRubNumber(BigInt(inv.vatAmountKopecks)),
          vatRate: inv.vatRate,
          supplier: supplierCp,
          buyer,
          lines,
          notes: inv.notes,
        });
        processedIds.push(inv.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ id: inv.id, message });
        logger.warn({ err, invoiceId: inv.id }, 'onec export: invoice failed');
      }
    }

    const xml = buildCommerceMlExport({
      packageId: `erfolg/${ctx.tenant.subdomain}/${exchange.id}`,
      generatedAt: new Date().toISOString(),
      documents: docs,
    });

    // Только теперь — файл собран. Одна транзакция, один UPDATE: либо помечены
    // все попавшие в файл счета, либо ни один.
    await markManyOnecSynced(ctx.db, ctx.tenant.id, processedIds, exchange.id);

    await completeExchange(ctx.db, ctx.tenant.id, exchange.id, {
      status: errors.length === 0 ? 'success' : docs.length > 0 ? 'partial' : 'failed',
      result: { processedIds, errors, xmlSize: xml.length },
      processedCount: processedIds.length,
      errorCount: errors.length,
    });

    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'export',
      entityType: 'onec_exchange',
      entityId: exchange.id,
      after: { processed: processedIds.length, errors: errors.length, kind: 'invoices_export' },
      ip: ctx.audit.ip ?? null,
      userAgent: ctx.audit.userAgent ?? null,
    });

    return {
      exchangeId: exchange.id,
      xml,
      processedCount: processedIds.length,
      errorCount: errors.length,
      totalPending,
      remaining: Math.max(0, totalPending - processedIds.length),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeExchange(ctx.db, ctx.tenant.id, exchange.id, {
      status: 'failed',
      errorMessage: message,
    });
    throw err;
  }
}

interface ReceivePaymentsCmdInput {
  body: unknown;
}

interface ReceivePaymentsResult {
  exchangeId: string;
  /** Сколько новых платежей создано. */
  processed: number;
  /** Сколько повторов (тот же external id) пропущено как идемпотентные. */
  skipped: number;
  errors: Array<{ ref: string; message: string }>;
}

/**
 * Принимает batch платежей из 1С. Для каждого resolves invoice по UUID или номеру и addPayment.
 * Аутентификация — на уровне Express-route (токен сверяется до вызова сюда).
 */
export async function receivePaymentsFromOnecCmd(
  db: Db,
  tenant: ResolvedTenant,
  input: ReceivePaymentsCmdInput,
): Promise<ReceivePaymentsResult> {
  const records = parseIncomingPayments(input.body);
  const exchange = await startExchange(db, tenant.id, {
    direction: 'import',
    kind: 'payments_import',
    payload: { ids: records.map((r) => r.invoiceExternalId ?? r.invoiceNumber ?? '') },
  });
  const errors: Array<{ ref: string; message: string }> = [];
  let processed = 0;
  let skipped = 0;
  try {
    for (const r of records) {
      const ref = r.invoiceExternalId ?? r.invoiceNumber ?? 'unknown';
      try {
        const invoice = await withTenantTx(db, tenant.id, async (tx) => {
          if (r.invoiceExternalId) {
            const rows = await tx
              .select({
                id: invoices.id,
                ticketId: invoices.ticketId,
                status: invoices.status,
              })
              .from(invoices)
              .where(eq(invoices.id, r.invoiceExternalId))
              .limit(1);
            return rows[0] ?? null;
          }
          if (r.invoiceNumber) {
            const rows = await tx
              .select({
                id: invoices.id,
                ticketId: invoices.ticketId,
                status: invoices.status,
              })
              .from(invoices)
              .where(eq(invoices.invoiceNumber, r.invoiceNumber))
              .limit(1);
            return rows[0] ?? null;
          }
          return null;
        });
        if (!invoice) {
          errors.push({ ref, message: 'invoice not found' });
          continue;
        }
        if (invoice.status === 'cancelled' || invoice.status === 'draft') {
          errors.push({ ref, message: `cannot pay invoice in status ${invoice.status}` });
          continue;
        }
        const amount =
          typeof r.amountKopecks === 'string'
            ? BigInt(r.amountKopecks)
            : BigInt(Math.round(r.amountKopecks));
        // Идемпотентность: external id из 1С уникален per payment. Повтор того же
        // webhook'а (network retry в 1С) не должен создавать дубль платежа.
        // External id берём из явного поля r.externalPaymentId, либо fallback на ref
        // (UUID счёта или его номер) — это всё равно стабильный ключ для одного платежа,
        // но менее точный. 1С обычно шлёт собственный ID документа.
        const externalId = r.externalPaymentId ?? ref;
        const result = await addPayment(db, tenant.id, {
          ticketId: invoice.ticketId,
          invoiceId: invoice.id,
          amountKopecks: amount,
          method: r.method,
          paidAt: new Date(r.paidAt),
          comment: r.comment ?? null,
          userId: null,
          externalPaymentId: externalId,
        });
        if (result.skipped) {
          skipped++;
        } else {
          processed++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ ref, message });
        logger.warn({ err, ref, tenantId: tenant.id }, 'onec import: payment failed');
      }
    }
    await completeExchange(db, tenant.id, exchange.id, {
      status: errors.length === 0 ? 'success' : processed + skipped > 0 ? 'partial' : 'failed',
      result: {
        processedIds: [],
        errors: errors.map((e) => ({ id: e.ref, message: e.message })),
      },
      processedCount: processed,
      errorCount: errors.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeExchange(db, tenant.id, exchange.id, {
      status: 'failed',
      errorMessage: message,
    });
    throw err;
  }
  return { exchangeId: exchange.id, processed, skipped, errors };
}

export interface GeneratedToken {
  token: string;
  hash: string;
}

/** Генерирует одноразовый bearer-token (показывается клиенту один раз). */
export function generateIncomingToken(): GeneratedToken {
  const token = randomBytes(32).toString('hex');
  return { token, hash: hashIncomingToken(token) };
}

/** Сверяет переданный токен с сохранённым hash'ем для tenant'а. */
export async function verifyTenantIncomingToken(
  db: Db,
  tenantId: string,
  providedToken: string,
): Promise<boolean> {
  const storedHash = await findEnabledTokenHashByTenant(db, tenantId);
  if (!storedHash) return false;
  try {
    return verifyIncomingToken(providedToken, storedHash);
  } catch {
    return false;
  }
}

export async function ensureEnabledOrThrow(db: Db, tenantId: string): Promise<void> {
  const hash = await findEnabledTokenHashByTenant(db, tenantId);
  if (!hash) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: '1С-обмен не настроен для этого тенанта',
    });
  }
}

void getDb; // imported for re-export pathway
