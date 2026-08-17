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
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { invoices, withTenantTx, workOrders, type Db, type InvoiceLineSnapshot } from '@erfolg/db';
import {
  RECEIVABLE_INVOICE_STATUSES as RECEIVABLE_STATUS_LIST,
  type InvoiceStatus,
  type VatRate,
} from '@erfolg/shared';
import { WorkOrderNotFoundError } from '../../lib/errors';
import { orgTodaySql, orgTodayValue } from '../../lib/org-day';

const INVOICE_COUNTER_KIND = 'invoice';
const DEFAULT_DUE_DAYS = 14;

/**
 * Статусы «счёт с остатком» (дебиторка): выставлен / частично оплачен / просрочен.
 * Единый источник для listClientOverdueInvoices и receivablesReport — чтобы экран
 * «Дебиторка» и кнопка «Напомнить» всегда опирались на один набор статусов.
 * Тот же набор используется на дашборде («Вам должны») и в частичном индексе invoices.
 *
 * СПИСОК ЖИВЁТ В `@erfolg/shared` (`RECEIVABLE_INVOICE_STATUSES`) — это же
 * определение читает карточка клиента, когда показывает долг. Здесь только
 * SQL-зеркало, собранное из того самого массива: разъехаться им теперь нечем.
 */
const RECEIVABLE_INVOICE_STATUSES = sql`(${sql.join(
  RECEIVABLE_STATUS_LIST.map((s) => sql`${s}`),
  sql`, `,
)})`;

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
  /**
   * Строки счёта на момент фиксации сумм. `null` — счёт выставлен до появления
   * снимка: печать берёт строки наряда, как раньше.
   */
  lines: InvoiceLineSnapshot[] | null;
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
    lines: row.linesSnapshot ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Снимок строк наряда — то, что напечатается в счёте.
 *
 * Снимаем РОВНО там, где фиксируются суммы (createDraft и transitionToIssued).
 * Иначе появилось бы третье состояние — «итог от одного момента, строки от
 * другого», то есть та же болезнь под другим именем.
 *
 * Числа кладём строками: в базе это bigint/numeric, а jsonb с числами свыше
 * 2^53 молча терял бы точность.
 */
async function snapshotWorkOrderLines(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  workOrderId: string,
): Promise<InvoiceLineSnapshot[]> {
  const rows = await tx.execute(sql`
    SELECT wol.line_type, wol.name, wol.unit, wol.quantity,
           wol.unit_price_kopecks, wol.amount_kopecks,
           u.full_name AS engineer_name
      FROM work_order_lines wol
      LEFT JOIN users u ON u.id = wol.engineer_id
     WHERE wol.work_order_id = ${workOrderId}::uuid
     ORDER BY wol.created_at ASC, wol.id ASC
  `);
  return (
    rows as unknown as Array<{
      line_type: string;
      name: string;
      unit: string;
      quantity: string;
      unit_price_kopecks: string;
      amount_kopecks: string;
      engineer_name: string | null;
    }>
  ).map((r) => ({
    lineType: r.line_type,
    name: r.name,
    unit: r.unit,
    quantity: String(r.quantity),
    unitPriceKopecks: String(r.unit_price_kopecks),
    amountKopecks: String(r.amount_kopecks),
    engineerName: r.engineer_name,
  }));
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

/** Дата-строка + дни, без часовых поясов (полночь UTC как нейтральная точка). */
function addDaysIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
/**
 * Статус заявки, к которой относится наряд. `null` — наряда или заявки нет.
 *
 * Нужен createDraftCmd: по отменённой заявке счёт выставлять нельзя, а статус на
 * этом пути не проверялся вовсе.
 */
export async function ticketStatusForWorkOrder(
  db: Db,
  tenantId: string,
  workOrderId: string,
): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT t.status
        FROM work_orders wo
        JOIN tickets t ON t.id = wo.ticket_id
       WHERE wo.id = ${workOrderId}::uuid
       LIMIT 1
    `)) as unknown as Array<{ status: string }>;
    return rows[0]?.status ?? null;
  });
}

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
      throw new WorkOrderNotFoundError('createDraft: work_order не найден в этом тенанте');
    }

    // 2. Если живой счёт уже есть — возвращаем его (даже draft, или issued, или cancelled).
    const existingRows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.workOrderId, wo.id), isNull(invoices.deletedAt)))
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
    // Дата выставления и год в номере — день ОРГАНИЗАЦИИ: по UTC счёт, выставленный
    // ночью, получал вчерашнюю дату, а первого января — прошлогодний номер.
    const issueDate = await orgTodayValue(tx, tenantId);
    const number = await nextInvoiceNumber(tx, tenantId, Number(issueDate.slice(0, 4)));
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
        issueDate,
        dueDate: addDaysIsoDate(issueDate, dueDays),
        notes: input.notes ?? null,
        linesSnapshot: await snapshotWorkOrderLines(tx, wo.id),
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
  /** Часть номера счёта; регистр и пробелы по краям не важны. */
  search?: string;
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
    // Поиск по номеру счёта — на СЕРВЕРЕ, по всей базе. Экран раньше фильтровал
    // уже полученные 25 строк страницы, а итог под таблицей показывал общий:
    // счёт с третьей страницы «не находился», и человек решал, что его нет.
    // Регистр и пробелы по краям не мешают — номер переписывают из бумаги.
    const search = opts.search?.trim();
    if (search) {
      filters.push(sql`${invoices.invoiceNumber} ILIKE ${'%' + search + '%'}`);
    }

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
    // Снимок из текущего наряда целиком: и сумма, И ставка НДС. Ставка на
    // счёте руками не правится нигде (updateDraft с ней не зовёт ни один
    // экран) — её источник тот же наряд, что и у суммы. Раньше сумма
    // освежалась, а НДС считался по ставке, запомненной при создании
    // черновика: поменял менеджер ставку наряда после черновика — клиент
    // получал счёт с новой суммой и старой ставкой.
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
    const vat = calcVatInclusive(wo.total, wo.vatRate);
    const now = new Date();
    const updated = await tx
      .update(invoices)
      .set({
        status: 'issued',
        totalAmountKopecks: wo.total,
        vatRate: wo.vatRate,
        vatAmountKopecks: vat,
        issueDate: await orgTodayValue(tx, tenantId),
        dueDate: opts.dueDate ?? row.dueDate,
        issuedAt: now,
        // Строки замораживаем вместе с суммой: иначе документ перестаёт
        // сходиться сам с собой, если наряд правят после выставления.
        linesSnapshot: await snapshotWorkOrderLines(tx, row.workOrderId),
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
    await tx.update(invoices).set({ deletedAt: new Date() }).where(eq(invoices.id, invoiceId));
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
export async function markOverdueAsOf(db: Db, tenantId: string, asOf: Date): Promise<number> {
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
/**
 * ⛔ СЕЙЧАС НЕ ИСПОЛЬЗУЕТСЯ в рабочем коде: её звал ночной робот-рассыльщик, а
 * рассылка отключена (решение владельца 2026-07-23, см. workers/invoice-reminder.ts).
 * Оставлена вместе с остальной выключенной рассылкой — если её вернут, брать отсюда.
 * Ручная кнопка «Напомнить» пользуется другой выборкой — listClientOverdueInvoices.
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
export async function markReminderSent(db: Db, tenantId: string, invoiceId: string): Promise<void> {
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

/**
 * Условие «счёт подлежит выгрузке в 1С».
 *
 * Черновик ещё не документ. Отменённый — тоже: отмена не проставляет deleted_at
 * (transitionToCancelled), поэтому раньше отменённые счета уезжали в бухгалтерию
 * и создавали там дебиторку, оплатить которую система же потом и отказывается.
 * Частичный индекс invoices_pending_onec_export_idx шире этого условия
 * (там только <> 'draft'), поэтому остаётся применимым.
 */
const PENDING_ONEC_STATUS = sql`${invoices.status} NOT IN ('draft', 'cancelled')`;

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
      .where(and(isNull(invoices.deletedAt), isNull(invoices.onecSyncedAt), PENDING_ONEC_STATUS))
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

/**
 * Помечает пачку счетов выгруженными ОДНИМ запросом в ОДНОЙ транзакции.
 *
 * Отметка необратима: снять её нечем ни в UI, ни в API. Поэтому она обязана
 * ставиться всем счетам сразу и только после того, как файл собран — иначе
 * половина счетов «уедет в 1С», которой они не увидят. Поштучный
 * markOnecSynced в цикле такого свойства не даёт: там N независимых
 * транзакций, и падение на середине оставляет разъехавшееся состояние.
 */
export async function markManyOnecSynced(
  db: Db,
  tenantId: string,
  invoiceIds: string[],
  externalId: string | null,
): Promise<void> {
  if (invoiceIds.length === 0) return;
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(invoices)
      .set({
        onecSyncedAt: new Date(),
        ...(externalId ? { onecExternalId: externalId } : {}),
      })
      .where(inArray(invoices.id, invoiceIds));
  });
}

/** Сколько всего счетов ждёт выгрузки (без потолка) — чтобы не врать «выгружены все». */
export async function countPendingOnecExport(db: Db, tenantId: string): Promise<number> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(isNull(invoices.deletedAt), isNull(invoices.onecSyncedAt), PENDING_ONEC_STATUS));
    return rows[0]?.n ?? 0;
  });
}

/* ============================== ДЕБИТОРКА (receivables) ============================== */

/**
 * Просроченные счета конкретного клиента (для ручной кнопки «Напомнить»).
 * «Просрочен» = due_date в прошлом + остаток > 0 (по дате, а не по статусу-флагу —
 * так экран и кнопка согласованы даже если ночной cron ещё не переставил флаг).
 */
export async function listClientOverdueInvoices(
  db: Db,
  tenantId: string,
  clientId: string,
  limit = 100,
): Promise<InvoiceDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(
        and(
          isNull(invoices.deletedAt),
          eq(invoices.clientId, clientId),
          sql`${invoices.status} IN ${RECEIVABLE_INVOICE_STATUSES}`,
          sql`${invoices.dueDate}::date < ${orgTodaySql(tenantId)}`,
          sql`${invoices.totalAmountKopecks} > ${invoices.paidAmountKopecks}`,
        ),
      )
      .orderBy(asc(invoices.dueDate))
      .limit(limit);
    return rows.map(toDto);
  });
}

export interface ReceivablesAgingBucket {
  /** Остаток по корзине в копейках (строка bigint). */
  sumKopecks: string;
  count: number;
}

export interface ReceivablesDebtor {
  clientId: string;
  clientName: string | null;
  clientEmail: string | null;
  /**
   * Карточка клиента в архиве. Строка при этом ОСТАЁТСЯ в отчёте с теми же суммами —
   * прячется не долг, а только исходящее письмо (робот и кнопка «Напомнить»).
   */
  clientArchived: boolean;
  /** Всего должен (остаток по всем неоплаченным счетам), копейки-строка. */
  totalOwedKopecks: string;
  /** Из них просрочено (due_date в прошлом), копейки-строка. */
  overdueOwedKopecks: string;
  /** Максимальная просрочка в днях среди счетов клиента (0, если просрочки нет). */
  maxDaysOverdue: number;
  invoiceCount: number;
  overdueInvoiceCount: number;
  /** Последнее авто/ручное напоминание по счетам клиента. ISO-строка или null. */
  lastReminderSentAt: string | null;
  /** Наибольшее число напоминаний среди счетов клиента. */
  reminderCount: number;
}

export interface ReceivablesReport {
  summary: {
    totalOutstandingKopecks: string;
    overdueOutstandingKopecks: string;
    debtorCount: number;
    invoiceCount: number;
    overdueInvoiceCount: number;
  };
  aging: {
    notDue: ReceivablesAgingBucket;
    d1_30: ReceivablesAgingBucket;
    d31_60: ReceivablesAgingBucket;
    d60plus: ReceivablesAgingBucket;
  };
  debtors: ReceivablesDebtor[];
}

interface DebtorRow {
  client_id: string;
  client_name: string | null;
  client_email: string | null;
  client_archived: boolean | null;
  total_owed: string;
  overdue_owed: string;
  max_days_overdue: number;
  invoice_count: number;
  overdue_invoice_count: number;
  last_reminder_sent_at: string | null;
  reminder_count: number;
}

interface AgingRow {
  bucket: 'not_due' | 'd1_30' | 'd31_60' | 'd60plus';
  sum_kopecks: string;
  cnt: number;
}

function sumBig(values: string[]): string {
  return values.reduce((acc, v) => acc + BigInt(v), 0n).toString();
}

/**
 * Отчёт «Дебиторка»: кто и сколько должен, разбивка по срокам (aging) и сводка.
 * База: живые счета в статусах issued/partially_paid/overdue с остатком > 0.
 * «Просрочено» и корзины aging считаются по due_date относительно дня организации
 * (lib/org-day.ts; не по статусу-флагу — так цифры не «мигают» между тиками ночного cron).
 */
export async function receivablesReport(
  db: Db,
  tenantId: string,
  limit = 200,
): Promise<ReceivablesReport> {
  return withTenantTx(db, tenantId, async (tx) => {
    const debtorRows = (await tx.execute(sql`
      SELECT
        i.client_id,
        c.display_name AS client_name,
        c.email        AS client_email,
        -- ТОЛЬКО пометка, БЕЗ фильтра. Долг архивного клиента обязан остаться на экране
        -- теми же суммами: архивацию используют как суррогат слияния дублей, счета на
        -- такой карточке настоящие. Убрать строку = стереть реальный долг (а шапка
        -- экрана считается из aging-корзин, которые clients вообще не джойнят, —
        -- фильтр здесь ещё и развалил бы сходимость «итого» с таблицей).
        (c.status = 'archived' OR c.deleted_at IS NOT NULL) AS client_archived,
        SUM(i.total_amount_kopecks - i.paid_amount_kopecks)::text AS total_owed,
        SUM(CASE WHEN i.due_date::date < ${orgTodaySql(tenantId)}
                 THEN i.total_amount_kopecks - i.paid_amount_kopecks ELSE 0 END)::text AS overdue_owed,
        COALESCE(MAX(CASE WHEN i.due_date::date < ${orgTodaySql(tenantId)}
                          THEN ${orgTodaySql(tenantId)} - i.due_date::date ELSE 0 END), 0)::int AS max_days_overdue,
        COUNT(*)::int AS invoice_count,
        COUNT(*) FILTER (WHERE i.due_date::date < ${orgTodaySql(tenantId)})::int AS overdue_invoice_count,
        MAX(i.last_reminder_sent_at)::text AS last_reminder_sent_at,
        COALESCE(MAX(i.reminder_count), 0)::int AS reminder_count
      FROM invoices i
      LEFT JOIN clients c ON c.id = i.client_id
      WHERE i.deleted_at IS NULL
        AND i.status IN ${RECEIVABLE_INVOICE_STATUSES}
        AND i.total_amount_kopecks > i.paid_amount_kopecks
      GROUP BY i.client_id, c.display_name, c.email, c.status, c.deleted_at
      ORDER BY
        SUM(CASE WHEN i.due_date::date < ${orgTodaySql(tenantId)}
                 THEN i.total_amount_kopecks - i.paid_amount_kopecks ELSE 0 END) DESC,
        SUM(i.total_amount_kopecks - i.paid_amount_kopecks) DESC
      LIMIT ${limit}
    `)) as unknown as DebtorRow[];

    const agingRows = (await tx.execute(sql`
      SELECT
        CASE
          WHEN i.due_date::date >= ${orgTodaySql(tenantId)} THEN 'not_due'
          WHEN ${orgTodaySql(tenantId)} - i.due_date::date <= 30 THEN 'd1_30'
          WHEN ${orgTodaySql(tenantId)} - i.due_date::date <= 60 THEN 'd31_60'
          ELSE 'd60plus'
        END AS bucket,
        SUM(i.total_amount_kopecks - i.paid_amount_kopecks)::text AS sum_kopecks,
        COUNT(*)::int AS cnt
      FROM invoices i
      WHERE i.deleted_at IS NULL
        AND i.status IN ${RECEIVABLE_INVOICE_STATUSES}
        AND i.total_amount_kopecks > i.paid_amount_kopecks
      GROUP BY bucket
    `)) as unknown as AgingRow[];

    // Число должников считаем БЕЗ лимита таблицы, чтобы заголовок был верным
    // даже если список должников длиннее limit.
    const debtorCountRows = (await tx.execute(sql`
      SELECT COUNT(DISTINCT i.client_id)::int AS cnt
      FROM invoices i
      WHERE i.deleted_at IS NULL
        AND i.status IN ${RECEIVABLE_INVOICE_STATUSES}
        AND i.total_amount_kopecks > i.paid_amount_kopecks
    `)) as unknown as Array<{ cnt: number }>;
    const debtorCount = debtorCountRows[0]?.cnt ?? 0;

    const debtors: ReceivablesDebtor[] = debtorRows.map((r) => ({
      clientId: r.client_id,
      clientName: r.client_name,
      clientEmail: r.client_email,
      // LEFT JOIN: карточки может не быть вовсе → считаем «не в архиве».
      clientArchived: r.client_archived === true,
      totalOwedKopecks: r.total_owed,
      overdueOwedKopecks: r.overdue_owed,
      maxDaysOverdue: r.max_days_overdue,
      invoiceCount: r.invoice_count,
      overdueInvoiceCount: r.overdue_invoice_count,
      lastReminderSentAt: r.last_reminder_sent_at,
      reminderCount: r.reminder_count,
    }));

    const emptyBucket: ReceivablesAgingBucket = { sumKopecks: '0', count: 0 };
    const aging = {
      notDue: { ...emptyBucket },
      d1_30: { ...emptyBucket },
      d31_60: { ...emptyBucket },
      d60plus: { ...emptyBucket },
    };
    const bucketKey: Record<AgingRow['bucket'], keyof typeof aging> = {
      not_due: 'notDue',
      d1_30: 'd1_30',
      d31_60: 'd31_60',
      d60plus: 'd60plus',
    };
    for (const row of agingRows) {
      const key = bucketKey[row.bucket];
      if (key) aging[key] = { sumKopecks: row.sum_kopecks, count: row.cnt };
    }

    // Сводка — по НЕограниченным aging-корзинам (не по обрезанному списку debtors).
    const overdueBuckets = [aging.d1_30, aging.d31_60, aging.d60plus];
    return {
      summary: {
        totalOutstandingKopecks: sumBig([aging.notDue, ...overdueBuckets].map((b) => b.sumKopecks)),
        overdueOutstandingKopecks: sumBig(overdueBuckets.map((b) => b.sumKopecks)),
        debtorCount,
        invoiceCount: aging.notDue.count + overdueBuckets.reduce((a, b) => a + b.count, 0),
        overdueInvoiceCount: overdueBuckets.reduce((a, b) => a + b.count, 0),
      },
      aging,
      debtors,
    };
  });
}
