/**
 * Repository для invoices.
 *
 * Бизнес-инварианты:
 *   • Один счёт на наряд (UNIQUE по (tenant_id, work_order_id) среди живых) —
 *     enforced на уровне БД. createDraft идемпотентен: если живой счёт на этот
 *     work_order уже есть — возвращает его.
 *   • Сквозная нумерация — через tenant_counters.kind='invoice' (UPSERT RETURNING).
 *   • totals (total/vat) — snapshot. Записываются при createDraft и переписываются
 *     при transitionToIssued (фикс на момент выставления). Дальше не меняются
 *     (даже если в work_order добавили строки).
 *   • paid_amount_kopecks — материализован через payments/repository.ts (8.B).
 *
 * Расчёт НДС — «вкладной» (НДС включён в total), формула совпадает с
 * apps/web/src/lib/pdf/invoice.ts: vat = round(total * rate / (100 + rate)).
 */
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  invoices,
  withTenantTx,
  workOrders,
  type Db,
} from '@erfolg/db';
import type { InvoiceStatus, VatRate } from '@erfolg/shared';
import { WorkOrderNotFoundError } from '../../lib/errors';

const INVOICE_COUNTER_KIND = 'invoice';
const DEFAULT_DUE_DAYS = 14;

/** Vat-percent по справочнику ставок. */
const VAT_PERCENT: Record<VatRate, number> = {
  '0': 0,
  '5': 5,
  '10': 10,
  '20': 20,
  without_vat: 0,
};

/** «Вкладной» НДС: vat = round(total * rate / (100 + rate)). */
export function calcVatInclusive(totalKopecks: bigint, vatRate: VatRate): bigint {
  const percent = VAT_PERCENT[vatRate];
  if (percent === 0) return 0n;
  const rate = BigInt(percent);
  const denom = BigInt(100 + percent);
  // округление к ближайшему: (a + denom/2) / denom
  const numerator = totalKopecks * rate;
  const half = denom / 2n;
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator < 0n ? -numerator : numerator;
  return sign * ((abs + half) / denom);
}

export interface InvoiceDto {
  id: string;
  invoiceNumber: string;
  clientId: string;
  ticketId: string;
  workOrderId: string;
  status: InvoiceStatus;
  vatRate: VatRate;
  /** bigint → string копейки. */
  totalAmountKopecks: string;
  vatAmountKopecks: string;
  paidAmountKopecks: string;
  /** ISO-дата 'YYYY-MM-DD'. */
  issueDate: string;
  dueDate: string;
  notes: string | null;
  issuedAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  lastReminderSentAt: Date | null;
  reminderCount: number;
  onecSyncedAt: Date | null;
  onecExternalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: typeof invoices.$inferSelect): InvoiceDto {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    clientId: row.clientId,
    ticketId: row.ticketId,
    workOrderId: row.workOrderId,
    status: row.status,
    vatRate: row.vatRate,
    totalAmountKopecks: row.totalAmountKopecks.toString(),
    vatAmountKopecks: row.vatAmountKopecks.toString(),
    paidAmountKopecks: row.paidAmountKopecks.toString(),
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    notes: row.notes,
    issuedAt: row.issuedAt,
    paidAt: row.paidAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    lastReminderSentAt: row.lastReminderSentAt,
    reminderCount: row.reminderCount,
    onecSyncedAt: row.onecSyncedAt,
    onecExternalId: row.onecExternalId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Атомарный INC сквозного счётчика. Формат "INV-2026-000017". */
async function nextInvoiceNumber(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  tenantId: string,
  year: number,
): Promise<string> {
  const result = await tx.execute(sql`
    INSERT INTO tenant_counters (tenant_id, kind, year, last_value)
    VALUES (${tenantId}::uuid, ${INVOICE_COUNTER_KIND}, ${year}, 1)
    ON CONFLICT (tenant_id, kind, year)
      DO UPDATE SET last_value = tenant_counters.last_value + 1,
                    updated_at = now()
    RETURNING last_value
  `);
  const rows = result as unknown as Array<{ last_value: number }>;
  const value = rows[0]?.last_value;
  if (typeof value !== 'number') {
    throw new Error('nextInvoiceNumber: counter UPSERT returned no value');
  }
  return `INV-${year}-${String(value).padStart(6, '0')}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

export interface CreateDraftInput {
  workOrderId: string;
  /** Опциональная отсрочка платежа в днях, default 14. */
  dueDays?: number;
  notes?: string | null;
}

/**
 * Создаёт черновик счёта по наряду. Идемпотентно: если живой счёт на этот наряд
 * уже есть — возвращает его (включая cancelled? нет: cancelled — это «закрытый»
 * для нового счёта по тому же наряду, мы отдадим cancelled и UI решит).
 *
 * total/vat снимаются с текущего work_order. На момент issue будут переписаны
 * актуальными значениями (см. transitionToIssued).
 */
export async function createDraft(
  db: Db,
  tenantId: string,
  input: CreateDraftInput,
): Promise<InvoiceDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    // 1. Загружаем work_order под блокировкой (UPDATE = exclusive row lock на дальнейший SELECT)
    const woRows = await tx
      .select({
        id: workOrders.id,
        ticketId: workOrders.ticketId,
        vatRate: workOrders.vatRate,
        total: workOrders.totalAmountKopecks,
      })
      .from(workOrders)
      .where(eq(workOrders.id, input.workOrderId))
      .for('update')
      .limit(1);
    const wo = woRows[0];
    if (!wo) {
      throw new WorkOrderNotFoundError(
        'createDraft: work_order не найден в этом тенанте',
      );
    }

    // 2. Если живой счёт уже есть — возвращаем его (даже draft, или issued, или cancelled).
    const existingRows = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.workOrderId, wo.id),
          isNull(invoices.deletedAt),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing) return toDto(existing);

    // 3. Берём ticket_id и client_id из заявки (через workOrder → ticket).
    const ticketRows = await tx.execute(sql`
      SELECT t.client_id, t.id AS ticket_id
        FROM tickets t
       WHERE t.id = ${wo.ticketId}::uuid
       LIMIT 1
    `);
    const ticketRow = (ticketRows as unknown as Array<{ client_id: string; ticket_id: string }>)[0];
    if (!ticketRow) throw new Error('createDraft: ticket not found');

    // 4. Номер + расчёт VAT snapshot (на момент draft, на issue будет refreshed).
    const now = new Date();
    const number = await nextInvoiceNumber(tx, tenantId, now.getUTCFullYear());
    const vat = calcVatInclusive(wo.total, wo.vatRate);
    const dueDays = input.dueDays ?? DEFAULT_DUE_DAYS;

    const inserted = await tx
      .insert(invoices)
      .values({
        tenantId,
        invoiceNumber: number,
        clientId: ticketRow.client_id,
        ticketId: ticketRow.ticket_id,
        workOrderId: wo.id,
        status: 'draft',
        vatRate: wo.vatRate,
        totalAmountKopecks: wo.total,
        vatAmountKopecks: vat,
        paidAmountKopecks: 0n,
        issueDate: isoDate(now),
        dueDate: isoDate(addDays(now, dueDays)),
        notes: input.notes ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('createDraft: insert returned nothing');
    return toDto(row);
  });
}

export async function getById(
  db: Db,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);
    return rows[0] ? toDto(rows[0]) : null;
  });
}

export async function listByTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<InvoiceDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.ticketId, ticketId), isNull(invoices.deletedAt)))
      .orderBy(desc(invoices.createdAt));
    return rows.map(toDto);
  });
}

export interface ListByClientOpts {
  status?: InvoiceStatus;
  limit?: number;
}

export async function listByClient(
  db: Db,
  tenantId: string,
  clientId: string,
  opts: ListByClientOpts = {},
): Promise<InvoiceDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [eq(invoices.clientId, clientId), isNull(invoices.deletedAt)];
    if (opts.status) filters.push(eq(invoices.status, opts.status));
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(...filters))
      .orderBy(desc(invoices.createdAt))
      .limit(opts.limit ?? 100);
    return rows.map(toDto);
  });
}

export interface ListForTenantOpts {
  status?: InvoiceStatus;
  limit?: number;
  offset?: number;
}

export interface ListForTenantResult {
  items: InvoiceDto[];
  total: number;
}

export async function listForTenant(
  db: Db,
  tenantId: string,
  opts: ListForTenantOpts = {},
): Promise<ListForTenantResult> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [isNull(invoices.deletedAt)];
    if (opts.status) filters.push(eq(invoices.status, opts.status));

    const countResult = await tx
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(invoices)
      .where(and(...filters));
    const total = countResult[0]?.count ?? 0;

    const rows = await tx
      .select()
      .from(invoices)
      .where(and(...filters))
      .orderBy(desc(invoices.createdAt))
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0);

    return { items: rows.map(toDto), total };
  });
}

export interface UpdateDraftInput {
  dueDate?: string;
  notes?: string | null;
  vatRate?: VatRate;
}

/** Только для status='draft'. На issued — fail. */
export async function updateDraft(
  db: Db,
  tenantId: string,
  invoiceId: string,
  patch: UpdateDraftInput,
): Promise<InvoiceDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.status !== 'draft') {
      throw new Error('updateDraft: можно править только черновик (status=draft)');
    }
    const setObj: Partial<typeof invoices.$inferInsert> = {};
    if (patch.dueDate !== undefined) setObj.dueDate = patch.dueDate;
    if (patch.notes !== undefined) setObj.notes = patch.notes;
    if (patch.vatRate !== undefined) {
      setObj.vatRate = patch.vatRate;
      setObj.vatAmountKopecks = calcVatInclusive(row.totalAmountKopecks, patch.vatRate);
    }
    if (Object.keys(setObj).length === 0) return toDto(row);
    const updated = await tx
      .update(invoices)
      .set(setObj)
      .where(eq(invoices.id, invoiceId))
      .returning();
    return updated[0] ? toDto(updated[0]) : null;
  });
}

/**
 * Переход draft → issued. Снимает свежий total с work_order (на случай если за время
 * черновика добавили работы), пересчитывает vat, ставит issued_at.
 *
 * Возвращает обновлённый DTO. Если уже не draft — кидает.
 */
export async function transitionToIssued(
  db: Db,
  tenantId: string,
  invoiceId: string,
  opts: { dueDate?: string } = {},
): Promise<InvoiceDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.status !== 'draft') {
      throw new Error(`transitionToIssued: счёт уже в статусе ${row.status}`);
    }
    // Refresh totals из текущего work_order
    const woRows = await tx
      .select({ total: workOrders.totalAmountKopecks, vatRate: workOrders.vatRate })
      .from(workOrders)
      .where(eq(workOrders.id, row.workOrderId))
      .limit(1);
    const wo = woRows[0];
    if (!wo) throw new Error('transitionToIssued: work_order missing');
    if (wo.total <= 0n) {
      throw new Error('transitionToIssued: нельзя выставить счёт на сумму 0');
    }
    const vat = calcVatInclusive(wo.total, row.vatRate);
    const now = new Date();
    const updated = await tx
      .update(invoices)
      .set({
        status: 'issued',
        totalAmountKopecks: wo.total,
        vatAmountKopecks: vat,
        issueDate: isoDate(now),
        dueDate: opts.dueDate ?? row.dueDate,
        issuedAt: now,
      })
      .where(eq(invoices.id, invoiceId))
      .returning();
    return updated[0] ? toDto(updated[0]) : null;
  });
}

export async function transitionToCancelled(
  db: Db,
  tenantId: string,
  invoiceId: string,
  reason: string | null,
): Promise<InvoiceDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.status === 'cancelled') return toDto(row);
    if (row.status === 'paid') {
      throw new Error('transitionToCancelled: нельзя отменить полностью оплаченный счёт');
    }
    const updated = await tx
      .update(invoices)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: reason,
      })
      .where(eq(invoices.id, invoiceId))
      .returning();
    return updated[0] ? toDto(updated[0]) : null;
  });
}

/**
 * Soft-delete draft (issued и далее — не удаляем, только cancelled).
 * Возвращает true если запись стала deleted, false если не нашлась/не draft.
 */
export async function softDeleteDraft(
  db: Db,
  tenantId: string,
  invoiceId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    if (row.status !== 'draft') return false;
    await tx
      .update(invoices)
      .set({ deletedAt: new Date() })
      .where(eq(invoices.id, invoiceId));
    return true;
  });
}

/**
 * Пересчёт статуса на основе paid_amount. Вызывается из payments/8.B
 * в той же транзакции после изменения payments.
 *
 * Логика:
 *   draft           → не трогаем (платежи на draft невалидны, но safety: не меняем)
 *   issued/partial  → если paid >= total → paid, иначе если paid > 0 → partially_paid
 *   paid            → если paid < total (например удалили платёж) → partially_paid (или issued)
 *   overdue         → если paid >= total → paid; если 0 < paid < total → partially_paid
 *                     (ставится в draft вручную, а в overdue ставится cron'ом 8.E)
 *   cancelled       → не трогаем (нельзя оживить отменённый счёт через оплату)
 */
export async function recomputeStatusFromPaid(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  invoiceId: string,
): Promise<void> {
  const rows = await tx
    .select({
      status: invoices.status,
      total: invoices.totalAmountKopecks,
      paid: invoices.paidAmountKopecks,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for('update')
    .limit(1);
  const row = rows[0];
  if (!row) return;
  if (row.status === 'draft' || row.status === 'cancelled') return;
  let next: InvoiceStatus = row.status;
  let paidAt: Date | null = null;
  if (row.paid >= row.total && row.total > 0n) {
    next = 'paid';
    paidAt = new Date();
  } else if (row.paid > 0n) {
    next = 'partially_paid';
  } else {
    // paid вернулся к 0 — откатываем в issued (если был partially), overdue остаётся overdue
    next = row.status === 'overdue' ? 'overdue' : 'issued';
  }
  if (next === row.status && next !== 'paid') return;
  await tx
    .update(invoices)
    .set({
      status: next,
      ...(next === 'paid' ? { paidAt } : { paidAt: null }),
    })
    .where(eq(invoices.id, invoiceId));
}

/** Проверка: invoice принадлежит tenant'у. */
export async function invoiceBelongsToTenant(
  db: Db,
  tenantId: string,
  invoiceId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * Помечает все issued/partially_paid счета с просроченным due_date как overdue.
 * Используется ночным cron'ом (8.E). Возвращает количество переведённых.
 */
export async function markOverdueAsOf(
  db: Db,
  tenantId: string,
  asOf: Date,
): Promise<number> {
  return withTenantTx(db, tenantId, async (tx) => {
    const result = await tx
      .update(invoices)
      .set({ status: 'overdue' })
      .where(
        and(
          isNull(invoices.deletedAt),
          sql`${invoices.status} IN ('issued', 'partially_paid')`,
          sql`${invoices.dueDate}::date < ${isoDate(asOf)}::date`,
        ),
      )
      .returning({ id: invoices.id });
    return result.length;
  });
}

/**
 * Список счетов, по которым нужно отправить email-напоминание.
 * Критерии: status IN (overdue), last_reminder_sent_at NULL или старше cooldown часов.
 */
export async function listOverdueForReminder(
  db: Db,
  tenantId: string,
  cooldownHours: number,
  limit = 100,
): Promise<InvoiceDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    // postgres-js bind Date криво — передаём ISO string через ::timestamptz cast.
    const cutoffIso = new Date(Date.now() - cooldownHours * 3600 * 1000).toISOString();
    const rows = await tx
      .select()
      .from(invoices)
      .where(
        and(
          isNull(invoices.deletedAt),
          eq(invoices.status, 'overdue'),
          sql`(${invoices.lastReminderSentAt} IS NULL OR ${invoices.lastReminderSentAt} <= ${cutoffIso}::timestamptz)`,
        ),
      )
      .orderBy(asc(invoices.dueDate))
      .limit(limit);
    return rows.map(toDto);
  });
}

/** Регистрирует факт отправки напоминания. */
export async function markReminderSent(
  db: Db,
  tenantId: string,
  invoiceId: string,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(invoices)
      .set({
        lastReminderSentAt: new Date(),
        reminderCount: sql`${invoices.reminderCount} + 1`,
      })
      .where(eq(invoices.id, invoiceId));
  });
}

/** Список счетов, ожидающих выгрузку в 1С (8.F). */
export async function listPendingOnecExport(
  db: Db,
  tenantId: string,
  limit = 200,
): Promise<InvoiceDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(
        and(
          isNull(invoices.deletedAt),
          isNull(invoices.onecSyncedAt),
          sql`${invoices.status} <> 'draft'`,
        ),
      )
      .orderBy(asc(invoices.updatedAt))
      .limit(limit);
    return rows.map(toDto);
  });
}

export async function markOnecSynced(
  db: Db,
  tenantId: string,
  invoiceId: string,
  externalId: string | null,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(invoices)
      .set({
        onecSyncedAt: new Date(),
        ...(externalId ? { onecExternalId: externalId } : {}),
      })
      .where(eq(invoices.id, invoiceId));
  });
}
