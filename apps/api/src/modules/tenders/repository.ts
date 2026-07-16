/**
 * Repository тендеров (tenders + tender_payments). Все запросы под withTenantTx (RLS FORCE).
 * Деньги — копейки (bigint, в DTO → string). «Оплачено» = SUM платежей (не материализуем:
 * платежей на тендер единицы, подзапрос дешёвый). Итоги/summary не учитывают расторгнутые.
 * Имя заказчика — join на clients.display_name (как в sales).
 */
import { and, desc, eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { clients, tenderPayments, tenders, withTenantTx, type Db } from '@erfolg/db';
import { ruIlike } from '../../lib/ru-search';

type Tx = Parameters<Parameters<typeof withTenantTx>[2]>[0];

export type TenderStatus = 'won' | 'in_progress' | 'fulfilled' | 'paid' | 'cancelled';

const PAGE_SIZE = 25;

export interface TenderPaymentDto {
  id: string;
  amountKopecks: string;
  paidOn: string;
  note: string | null;
}

export interface TenderListDto {
  id: string;
  contractNumber: string;
  purchaseNumber: string | null;
  clientId: string;
  clientName: string | null;
  amountKopecks: string;
  paidKopecks: string;
  /** Сумма − оплачено (может быть отрицательным при переплате). */
  restKopecks: string;
  contractDate: string;
  dueDate: string | null;
  status: TenderStatus;
  paymentsCount: number;
  createdAt: Date;
}

export interface TenderDetailDto extends TenderListDto {
  comment: string | null;
  payments: TenderPaymentDto[];
}

export interface TendersPeriod {
  /** YYYY-MM-DD включительно, по дате контракта. */
  from?: string;
  to?: string;
}

export interface TendersSummary {
  /** Σ сумм контрактов (без расторгнутых). */
  amountKopecks: string;
  /** Σ платежей по этим контрактам. */
  paidKopecks: string;
  /** amount − paid. */
  outstandingKopecks: string;
  count: number;
}

/* ───────────────────────────── helpers ───────────────────────────── */

const listSelect = {
  tender: tenders,
  clientName: clients.displayName,
  paidKopecks: sql<string>`COALESCE((SELECT SUM(tp.amount_kopecks) FROM tender_payments tp WHERE tp.tender_id = ${tenders.id}), 0)::bigint::text`,
  paymentsCount: sql<number>`(SELECT count(*)::int FROM tender_payments tp WHERE tp.tender_id = ${tenders.id})`,
};

function toListDto(r: {
  tender: typeof tenders.$inferSelect;
  clientName: string | null;
  paidKopecks: string;
  paymentsCount: number;
}): TenderListDto {
  const t = r.tender;
  const paid = BigInt(r.paidKopecks);
  return {
    id: t.id,
    contractNumber: t.contractNumber,
    purchaseNumber: t.purchaseNumber ?? null,
    clientId: t.clientId,
    clientName: r.clientName ?? null,
    amountKopecks: t.amountKopecks.toString(),
    paidKopecks: paid.toString(),
    restKopecks: (BigInt(t.amountKopecks) - paid).toString(),
    contractDate: t.contractDate,
    dueDate: t.dueDate ?? null,
    status: t.status,
    paymentsCount: r.paymentsCount,
    createdAt: t.createdAt,
  };
}

function periodFilters(period: TendersPeriod): SQL[] {
  const parts: SQL[] = [];
  if (period.from) parts.push(gte(tenders.contractDate, period.from));
  if (period.to) parts.push(lte(tenders.contractDate, period.to));
  return parts;
}

/* ───────────────────────────── queries ───────────────────────────── */

export interface ListOpts extends TendersPeriod {
  search?: string;
  status?: TenderStatus;
  page?: number;
}

export async function listTenders(
  db: Db,
  tenantId: string,
  opts: ListOpts = {},
): Promise<{ items: TenderListDto[]; total: number }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [isNull(tenders.deletedAt), ...periodFilters(opts)];
    if (opts.status) filters.push(eq(tenders.status, opts.status));
    if (opts.search) {
      const q = `%${opts.search.trim()}%`;
      filters.push(
        or(
          ruIlike(clients.displayName, q),
          ruIlike(tenders.contractNumber, q),
          ruIlike(tenders.purchaseNumber, q),
        ) as SQL,
      );
    }
    const where = and(...filters);
    const page = Math.max(1, opts.page ?? 1);

    const rows = await tx
      .select(listSelect)
      .from(tenders)
      .leftJoin(clients, eq(clients.id, tenders.clientId))
      .where(where)
      .orderBy(desc(tenders.contractDate), desc(tenders.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);

    const totalRes = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(tenders)
      .leftJoin(clients, eq(clients.id, tenders.clientId))
      .where(where);

    return { items: rows.map(toListDto), total: totalRes[0]?.value ?? 0 };
  });
}

export async function getTender(
  db: Db,
  tenantId: string,
  id: string,
): Promise<TenderDetailDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select(listSelect)
      .from(tenders)
      .leftJoin(clients, eq(clients.id, tenders.clientId))
      .where(and(eq(tenders.id, id), isNull(tenders.deletedAt)))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    const payments = await tx
      .select()
      .from(tenderPayments)
      .where(eq(tenderPayments.tenderId, id))
      .orderBy(tenderPayments.paidOn, tenderPayments.createdAt);
    return {
      ...toListDto(r),
      comment: r.tender.comment ?? null,
      payments: payments.map((p) => ({
        id: p.id,
        amountKopecks: p.amountKopecks.toString(),
        paidOn: p.paidOn,
        note: p.note ?? null,
      })),
    };
  });
}

/** Итоги за период (по дате контракта): суммы, оплачено, остаток. Расторгнутые не считаем. */
export async function tendersSummary(
  db: Db,
  tenantId: string,
  period: TendersPeriod = {},
): Promise<TendersSummary> {
  return withTenantTx(db, tenantId, async (tx) => {
    const fromCond = period.from ? sql`AND t.contract_date >= ${period.from}::date` : sql``;
    const toCond = period.to ? sql`AND t.contract_date <= ${period.to}::date` : sql``;
    const rows = (await tx.execute(sql`
      SELECT
        COALESCE(SUM(t.amount_kopecks), 0)::bigint::text AS amount,
        COUNT(*)::int                                    AS cnt,
        COALESCE(SUM((SELECT SUM(tp.amount_kopecks) FROM tender_payments tp WHERE tp.tender_id = t.id)), 0)::bigint::text AS paid
      FROM tenders t
      WHERE t.tenant_id = ${tenantId}::uuid
        AND t.deleted_at IS NULL
        AND t.status <> 'cancelled'
        ${fromCond}
        ${toCond}
    `)) as unknown as Array<{ amount: string; cnt: number; paid: string }>;
    const amount = BigInt(rows[0]?.amount ?? '0');
    const paid = BigInt(rows[0]?.paid ?? '0');
    return {
      amountKopecks: amount.toString(),
      paidKopecks: paid.toString(),
      outstandingKopecks: (amount - paid).toString(),
      count: rows[0]?.cnt ?? 0,
    };
  });
}

/* ───────────────────────────── commands ──────────────────────────── */

export interface CreateTenderInput {
  clientId: string;
  contractNumber: string;
  purchaseNumber?: string | null;
  amountKopecks: bigint;
  contractDate: string;
  dueDate?: string | null;
  comment?: string | null;
  createdBy: string | null;
}

export async function createTender(
  db: Db,
  tenantId: string,
  input: CreateTenderInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(tenders)
      .values({
        tenantId,
        clientId: input.clientId,
        contractNumber: input.contractNumber,
        purchaseNumber: input.purchaseNumber ?? null,
        amountKopecks: input.amountKopecks,
        contractDate: input.contractDate,
        dueDate: input.dueDate ?? null,
        comment: input.comment ?? null,
        createdBy: input.createdBy,
      })
      .returning({ id: tenders.id });
    return inserted[0]!;
  });
}

export interface UpdateTenderPatch {
  clientId?: string;
  contractNumber?: string;
  purchaseNumber?: string | null;
  amountKopecks?: bigint;
  contractDate?: string;
  dueDate?: string | null;
  comment?: string | null;
}

export async function updateTender(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateTenderPatch,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.clientId !== undefined) set.clientId = patch.clientId;
    if (patch.contractNumber !== undefined) set.contractNumber = patch.contractNumber;
    if (patch.purchaseNumber !== undefined) set.purchaseNumber = patch.purchaseNumber;
    if (patch.amountKopecks !== undefined) set.amountKopecks = patch.amountKopecks;
    if (patch.contractDate !== undefined) set.contractDate = patch.contractDate;
    if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;
    if (patch.comment !== undefined) set.comment = patch.comment;
    if (Object.keys(set).length === 0) return true;
    const updated = await tx
      .update(tenders)
      .set(set)
      .where(and(eq(tenders.id, id), isNull(tenders.deletedAt)))
      .returning({ id: tenders.id });
    return updated.length > 0;
  });
}

export async function setTenderStatus(
  db: Db,
  tenantId: string,
  id: string,
  status: TenderStatus,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(tenders)
      .set({ status })
      .where(and(eq(tenders.id, id), isNull(tenders.deletedAt)))
      .returning({ id: tenders.id });
    return updated.length > 0;
  });
}

/** Мягкое удаление тендера (платежи остаются в БД, но тендер скрыт отовсюду). */
export async function deleteTender(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(tenders)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(tenders.id, id), isNull(tenders.deletedAt)))
      .returning({ id: tenders.id });
    return updated.length > 0;
  });
}

async function liveTenderExists(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: tenders.id })
    .from(tenders)
    .where(and(eq(tenders.id, id), isNull(tenders.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

export interface AddPaymentInput {
  tenderId: string;
  amountKopecks: bigint;
  paidOn: string;
  note?: string | null;
}

export async function addTenderPayment(
  db: Db,
  tenantId: string,
  input: AddPaymentInput,
): Promise<{ id: string }> {
  if (input.amountKopecks <= 0n) throw new Error('Сумма платежа должна быть больше нуля');
  return withTenantTx(db, tenantId, async (tx) => {
    if (!(await liveTenderExists(tx, input.tenderId))) throw new Error('Тендер не найден');
    const inserted = await tx
      .insert(tenderPayments)
      .values({
        tenantId,
        tenderId: input.tenderId,
        amountKopecks: input.amountKopecks,
        paidOn: input.paidOn,
        note: input.note ?? null,
      })
      .returning({ id: tenderPayments.id });
    return inserted[0]!;
  });
}

export async function deleteTenderPayment(
  db: Db,
  tenantId: string,
  paymentId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const deleted = await tx
      .delete(tenderPayments)
      .where(eq(tenderPayments.id, paymentId))
      .returning({ id: tenderPayments.id });
    return deleted.length > 0;
  });
}
