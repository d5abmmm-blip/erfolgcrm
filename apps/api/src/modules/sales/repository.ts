/**
 * Repository продаж (sales + sale_items). Все запросы под withTenantTx (RLS FORCE).
 *
 * total_kopecks материализован — пересчитывается из позиций при каждом изменении.
 * Оплата клиентом проводится в кассу как доход (статья «Продажа запчастей») — паттерн
 * payroll-выплат: одна cash-операция на продажу, ссылка в sales.cash_transaction_id,
 * отмена оплаты мягко удаляет операцию и пересчитывает остаток счёта.
 *
 * Имя клиента резолвится join'ом на clients.display_name (как в trade-in).
 */
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  cashAccounts,
  cashCategories,
  cashTransactions,
  clients,
  sales,
  saleItems,
  withTenantTx,
  type Db,
} from '@erfolg/db';
import { ruIlike } from '../../lib/ru-search';
import { recalcAccountBalanceInTx } from '../cash/repository';

type Tx = Parameters<Parameters<typeof withTenantTx>[2]>[0];

export type SaleStatus = 'new' | 'ordered' | 'received' | 'handed_over' | 'cancelled';

export interface SaleItemInput {
  name: string;
  quantity: number;
  unitPriceKopecks: bigint;
}

export interface SaleItemDto {
  id: string;
  name: string;
  quantity: number;
  unitPriceKopecks: string;
  lineTotalKopecks: string;
}

export interface SaleListDto {
  id: string;
  saleNo: number;
  clientId: string;
  clientName: string | null;
  status: SaleStatus;
  totalKopecks: string;
  itemsCount: number;
  isPaid: boolean;
  paidOn: string | null;
  createdAt: Date;
}

export interface SaleDetailDto extends SaleListDto {
  supplier: string | null;
  purchaseCostKopecks: string;
  /** total − purchase (если задана закупка). */
  marginKopecks: string | null;
  accountId: string | null;
  cashTransactionId: string | null;
  comment: string | null;
  items: SaleItemDto[];
}

const PAGE_SIZE = 25;

/* ───────────────────────────── helpers ───────────────────────────── */

async function recomputeTotal(tx: Tx, saleId: string): Promise<bigint> {
  const rows = (await tx.execute(sql`
    SELECT COALESCE(SUM(quantity * unit_price_kopecks), 0)::bigint::text AS total
    FROM sale_items WHERE sale_id = ${saleId}::uuid
  `)) as unknown as Array<{ total: string }>;
  const total = BigInt(rows[0]?.total ?? '0');
  await tx.update(sales).set({ totalKopecks: total }).where(eq(sales.id, saleId));
  return total;
}

async function loadItems(tx: Tx, saleId: string): Promise<SaleItemDto[]> {
  const rows = await tx
    .select()
    .from(saleItems)
    .where(eq(saleItems.saleId, saleId))
    .orderBy(saleItems.sortOrder, saleItems.createdAt);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    quantity: r.quantity,
    unitPriceKopecks: r.unitPriceKopecks.toString(),
    lineTotalKopecks: (BigInt(r.quantity) * r.unitPriceKopecks).toString(),
  }));
}

async function insertItems(
  tx: Tx,
  tenantId: string,
  saleId: string,
  items: SaleItemInput[],
): Promise<void> {
  if (items.length === 0) return;
  await tx.insert(saleItems).values(
    items.map((it, idx) => ({
      tenantId,
      saleId,
      name: it.name,
      quantity: it.quantity,
      unitPriceKopecks: it.unitPriceKopecks,
      sortOrder: idx,
    })),
  );
}

/** Статья дохода «Продажа запчастей» — найти по имени или создать. */
async function ensureSalesCategory(tx: Tx, tenantId: string): Promise<string> {
  const existing = await tx
    .select({ id: cashCategories.id })
    .from(cashCategories)
    .where(
      and(
        eq(cashCategories.tenantId, tenantId),
        eq(cashCategories.direction, 'income'),
        eq(cashCategories.name, 'Продажа запчастей'),
        isNull(cashCategories.deletedAt),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await tx
    .insert(cashCategories)
    .values({ tenantId, name: 'Продажа запчастей', direction: 'income', isSystem: true })
    .returning({ id: cashCategories.id });
  return inserted[0]!.id;
}

const listSelect = {
  sale: sales,
  clientName: clients.displayName,
  itemsCount: sql<number>`(SELECT count(*)::int FROM sale_items si WHERE si.sale_id = ${sales.id})`,
};

function toListDto(r: {
  sale: typeof sales.$inferSelect;
  clientName: string | null;
  itemsCount: number;
}): SaleListDto {
  const s = r.sale;
  return {
    id: s.id,
    saleNo: s.saleNo,
    clientId: s.clientId,
    clientName: r.clientName ?? null,
    status: s.status,
    totalKopecks: s.totalKopecks.toString(),
    itemsCount: r.itemsCount,
    isPaid: s.paidOn !== null,
    paidOn: s.paidOn ?? null,
    createdAt: s.createdAt,
  };
}

/* ───────────────────────────── queries ───────────────────────────── */

export interface ListOpts {
  search?: string;
  status?: SaleStatus;
  page?: number;
}

export async function listSales(
  db: Db,
  tenantId: string,
  opts: ListOpts = {},
): Promise<{ items: SaleListDto[]; total: number }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [isNull(sales.deletedAt)];
    if (opts.status) filters.push(eq(sales.status, opts.status));
    if (opts.search) {
      const q = `%${opts.search.trim()}%`;
      filters.push(
        or(
          ruIlike(clients.displayName, q),
          sql`CAST(${sales.saleNo} AS text) LIKE ${q}`,
          ruIlike(sales.supplier, q),
        ) as SQL,
      );
    }
    const where = and(...filters);
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * PAGE_SIZE;

    const rows = await tx
      .select(listSelect)
      .from(sales)
      .leftJoin(clients, eq(clients.id, sales.clientId))
      .where(where)
      .orderBy(desc(sales.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset);

    const totalRes = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(sales)
      .leftJoin(clients, eq(clients.id, sales.clientId))
      .where(where);

    return { items: rows.map(toListDto), total: totalRes[0]?.value ?? 0 };
  });
}

export async function getSale(
  db: Db,
  tenantId: string,
  id: string,
): Promise<SaleDetailDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select(listSelect)
      .from(sales)
      .leftJoin(clients, eq(clients.id, sales.clientId))
      .where(and(eq(sales.id, id), isNull(sales.deletedAt)))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    const base = toListDto(r);
    const s = r.sale;
    const total = BigInt(s.totalKopecks);
    const purchase = BigInt(s.purchaseCostKopecks);
    return {
      ...base,
      supplier: s.supplier ?? null,
      purchaseCostKopecks: purchase.toString(),
      marginKopecks: purchase > 0n ? (total - purchase).toString() : null,
      accountId: s.accountId ?? null,
      cashTransactionId: s.cashTransactionId ?? null,
      comment: s.comment ?? null,
      items: await loadItems(tx, id),
    };
  });
}

/* ───────────────────────────── commands ──────────────────────────── */

export interface CreateSaleInput {
  clientId: string;
  supplier: string | null;
  purchaseCostKopecks: bigint;
  comment: string | null;
  items: SaleItemInput[];
  createdBy: string | null;
}

export async function createSale(
  db: Db,
  tenantId: string,
  input: CreateSaleInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const noRows = (await tx.execute(sql`
      SELECT COALESCE(MAX(sale_no), 0) + 1 AS next FROM sales WHERE tenant_id = ${tenantId}::uuid
    `)) as unknown as Array<{ next: number }>;
    const saleNo = noRows[0]?.next ?? 1;

    const inserted = await tx
      .insert(sales)
      .values({
        tenantId,
        saleNo,
        clientId: input.clientId,
        supplier: input.supplier,
        purchaseCostKopecks: input.purchaseCostKopecks,
        comment: input.comment,
        createdBy: input.createdBy,
      })
      .returning({ id: sales.id });
    const id = inserted[0]!.id;
    await insertItems(tx, tenantId, id, input.items);
    await recomputeTotal(tx, id);
    return { id };
  });
}

export interface UpdateSaleInput {
  supplier?: string | null;
  purchaseCostKopecks?: bigint;
  comment?: string | null;
  items?: SaleItemInput[];
}

export async function updateSale(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateSaleInput,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const cur = await tx
      .select({ id: sales.id, paidOn: sales.paidOn })
      .from(sales)
      .where(and(eq(sales.id, id), isNull(sales.deletedAt)))
      .limit(1);
    if (!cur[0]) return false;
    if (cur[0].paidOn !== null) {
      throw new Error('Нельзя редактировать оплаченную продажу — сначала отмените оплату');
    }

    const set: Record<string, unknown> = {};
    if (patch.supplier !== undefined) set.supplier = patch.supplier;
    if (patch.purchaseCostKopecks !== undefined) set.purchaseCostKopecks = patch.purchaseCostKopecks;
    if (patch.comment !== undefined) set.comment = patch.comment;
    if (Object.keys(set).length > 0) {
      await tx.update(sales).set(set).where(eq(sales.id, id));
    }

    if (patch.items) {
      await tx.delete(saleItems).where(eq(saleItems.saleId, id));
      await insertItems(tx, tenantId, id, patch.items);
      await recomputeTotal(tx, id);
    }
    return true;
  });
}

export async function setSaleStatus(
  db: Db,
  tenantId: string,
  id: string,
  status: SaleStatus,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(sales)
      .set({ status })
      .where(and(eq(sales.id, id), isNull(sales.deletedAt)))
      .returning({ id: sales.id });
    return updated.length > 0;
  });
}

export interface PaySaleInput {
  accountId: string;
  paidOn: string;
  userId: string | null;
}

/** Принять оплату: доход в кассе на сумму продажи + отметка оплаты. */
export async function paySale(
  db: Db,
  tenantId: string,
  id: string,
  input: PaySaleInput,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(sales)
      .where(and(eq(sales.id, id), isNull(sales.deletedAt)))
      .limit(1);
    const sale = rows[0];
    if (!sale) return false;
    if (sale.paidOn !== null) throw new Error('Продажа уже оплачена');
    if (BigInt(sale.totalKopecks) <= 0n) throw new Error('Нельзя принять оплату на нулевую сумму');

    const acc = await tx
      .select({ id: cashAccounts.id })
      .from(cashAccounts)
      .where(
        and(
          eq(cashAccounts.tenantId, tenantId),
          eq(cashAccounts.id, input.accountId),
          isNull(cashAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (!acc[0]) throw new Error('Денежный счёт не найден');

    const categoryId = await ensureSalesCategory(tx, tenantId);
    const cashRow = await tx
      .insert(cashTransactions)
      .values({
        tenantId,
        kind: 'income',
        accountId: input.accountId,
        categoryId,
        amountKopecks: BigInt(sale.totalKopecks),
        occurredOn: input.paidOn,
        comment: `Продажа №${sale.saleNo}`,
        clientId: sale.clientId,
        userId: input.userId,
        source: 'manual',
      })
      .returning({ id: cashTransactions.id });
    await recalcAccountBalanceInTx(tx, tenantId, input.accountId);

    await tx
      .update(sales)
      .set({ paidOn: input.paidOn, accountId: input.accountId, cashTransactionId: cashRow[0]!.id })
      .where(eq(sales.id, id));
    return true;
  });
}

/** Отмена оплаты: мягко удаляем доход в кассе + пересчёт + очистка отметки. */
export async function unpaySale(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: sales.id,
        accountId: sales.accountId,
        cashTransactionId: sales.cashTransactionId,
      })
      .from(sales)
      .where(and(eq(sales.id, id), isNull(sales.deletedAt)))
      .limit(1);
    const sale = rows[0];
    if (!sale) return false;
    if (sale.cashTransactionId) {
      await tx
        .update(cashTransactions)
        .set({ deletedAt: new Date() })
        .where(eq(cashTransactions.id, sale.cashTransactionId));
      if (sale.accountId) await recalcAccountBalanceInTx(tx, tenantId, sale.accountId);
    }
    await tx
      .update(sales)
      .set({ paidOn: null, accountId: null, cashTransactionId: null })
      .where(eq(sales.id, id));
    return true;
  });
}

/** Удаление продажи (мягкое): сперва снимаем оплату (если была), затем deleted_at. */
export async function deleteSale(db: Db, tenantId: string, id: string): Promise<boolean> {
  const unpaid = await unpaySale(db, tenantId, id);
  if (!unpaid) return false;
  return withTenantTx(db, tenantId, async (tx) => {
    await tx.update(sales).set({ deletedAt: new Date() }).where(eq(sales.id, id));
    return true;
  });
}
