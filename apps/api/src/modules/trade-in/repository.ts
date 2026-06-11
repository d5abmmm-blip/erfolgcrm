/**
 * Repository trade_in_items. Все запросы под withTenantTx (RLS FORCE).
 *
 * Деньги — bigint копейки, в DTO строками (паттерн dashboard).
 * Имена клиента/покупателя резолвятся join'ами на clients (две алиас-копии).
 *
 * completeTradeIn — атомарно: status→sold + soldAt=today, и если привязан asset
 * с другим владельцем — перенос assets.owner_client_id + событие owner_change
 * в asset_events (event-sourcing-lite, как в остальном v2).
 */
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { assetEvents, assets, clients, tradeInItems, withTenantTx, type Db } from '@erfolg/db';
import type { TradeInCondition, TradeInStatus } from '@erfolg/shared';

const sellerClients = alias(clients, 'seller_clients');
const buyerClients = alias(clients, 'buyer_clients');

export interface TradeInDto {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  year: number | null;
  condition: TradeInCondition;
  status: TradeInStatus;
  clientId: string | null;
  clientDisplayName: string | null;
  buyerClientId: string | null;
  buyerDisplayName: string | null;
  assetId: string | null;
  purchasePriceKopecks: string;
  assessedPriceKopecks: string;
  salePriceKopecks: string | null;
  /** sale - purchase, только когда salePrice задан. */
  marginKopecks: string | null;
  notes: string | null;
  receivedAt: string;
  soldAt: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTradeInInput {
  name: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  year?: number | null;
  condition?: TradeInCondition;
  clientId?: string | null;
  assetId?: string | null;
  purchasePriceKopecks: bigint;
  assessedPriceKopecks: bigint;
  notes?: string | null;
  receivedAt: string;
}

export interface UpdateTradeInPatch {
  name?: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  year?: number | null;
  condition?: TradeInCondition;
  /** sold недопустим — только через completeTradeIn (валидируется в service). */
  status?: Exclude<TradeInStatus, 'sold'>;
  clientId?: string | null;
  buyerClientId?: string | null;
  assetId?: string | null;
  purchasePriceKopecks?: bigint;
  assessedPriceKopecks?: bigint;
  salePriceKopecks?: bigint | null;
  notes?: string | null;
  receivedAt?: string;
}

export interface ListOpts {
  search?: string;
  status?: TradeInStatus;
  page?: number;
}

export interface TradeInStats {
  received: number;
  assessed: number;
  inStock: number;
  sold: number;
  scrapped: number;
  /** Вложено в склад (purchase) по нереализованным позициям. */
  investedKopecks: string;
  /** Выручка по проданным. */
  soldRevenueKopecks: string;
  /** Маржа по проданным (sale - purchase). */
  soldMarginKopecks: string;
}

const PAGE_SIZE = 25;

interface JoinedRow {
  item: typeof tradeInItems.$inferSelect;
  clientDisplayName: string | null;
  buyerDisplayName: string | null;
}

function rowToDto(r: JoinedRow): TradeInDto {
  const t = r.item;
  return {
    id: t.id,
    name: t.name,
    manufacturer: t.manufacturer ?? null,
    model: t.model ?? null,
    serialNumber: t.serialNumber ?? null,
    year: t.year ?? null,
    condition: t.condition,
    status: t.status,
    clientId: t.clientId ?? null,
    clientDisplayName: r.clientDisplayName ?? null,
    buyerClientId: t.buyerClientId ?? null,
    buyerDisplayName: r.buyerDisplayName ?? null,
    assetId: t.assetId ?? null,
    purchasePriceKopecks: t.purchasePriceKopecks.toString(),
    assessedPriceKopecks: t.assessedPriceKopecks.toString(),
    salePriceKopecks: t.salePriceKopecks?.toString() ?? null,
    marginKopecks:
      t.salePriceKopecks !== null && t.salePriceKopecks !== undefined
        ? (t.salePriceKopecks - t.purchasePriceKopecks).toString()
        : null,
    notes: t.notes ?? null,
    receivedAt: t.receivedAt,
    soldAt: t.soldAt ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

const joinedSelect = {
  item: tradeInItems,
  clientDisplayName: sellerClients.displayName,
  buyerDisplayName: buyerClients.displayName,
};

export async function listTradeIns(
  db: Db,
  tenantId: string,
  opts: ListOpts = {},
): Promise<{ items: TradeInDto[]; total: number }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [isNull(tradeInItems.deletedAt)];
    if (opts.status) filters.push(eq(tradeInItems.status, opts.status));
    if (opts.search) {
      const q = `%${opts.search.trim()}%`;
      filters.push(
        or(
          ilike(tradeInItems.name, q),
          ilike(tradeInItems.manufacturer, q),
          ilike(tradeInItems.model, q),
          ilike(tradeInItems.serialNumber, q),
          ilike(sellerClients.displayName, q),
          ilike(buyerClients.displayName, q),
        ) as SQL,
      );
    }
    const where = and(...filters);
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * PAGE_SIZE;

    const rows = await tx
      .select(joinedSelect)
      .from(tradeInItems)
      .leftJoin(sellerClients, eq(sellerClients.id, tradeInItems.clientId))
      .leftJoin(buyerClients, eq(buyerClients.id, tradeInItems.buyerClientId))
      .where(where)
      .orderBy(desc(tradeInItems.receivedAt), desc(tradeInItems.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset);

    const totalResult = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(tradeInItems)
      .leftJoin(sellerClients, eq(sellerClients.id, tradeInItems.clientId))
      .leftJoin(buyerClients, eq(buyerClients.id, tradeInItems.buyerClientId))
      .where(where);

    return { items: rows.map(rowToDto), total: totalResult[0]?.value ?? 0 };
  });
}

export async function getTradeInById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<TradeInDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select(joinedSelect)
      .from(tradeInItems)
      .leftJoin(sellerClients, eq(sellerClients.id, tradeInItems.clientId))
      .leftJoin(buyerClients, eq(buyerClients.id, tradeInItems.buyerClientId))
      .where(and(eq(tradeInItems.id, id), isNull(tradeInItems.deletedAt)))
      .limit(1);
    return rows[0] ? rowToDto(rows[0]) : null;
  });
}

export async function createTradeIn(
  db: Db,
  tenantId: string,
  input: CreateTradeInInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(tradeInItems)
      .values({
        tenantId,
        name: input.name,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        serialNumber: input.serialNumber ?? null,
        year: input.year ?? null,
        condition: input.condition ?? 'good',
        clientId: input.clientId ?? null,
        assetId: input.assetId ?? null,
        purchasePriceKopecks: input.purchasePriceKopecks,
        assessedPriceKopecks: input.assessedPriceKopecks,
        notes: input.notes ?? null,
        receivedAt: input.receivedAt,
      })
      .returning({ id: tradeInItems.id });
    const row = inserted[0];
    if (!row) throw new Error('createTradeIn: nothing returned');
    return row;
  });
}

export async function updateTradeIn(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateTradeInPatch,
): Promise<TradeInDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.manufacturer !== undefined) set.manufacturer = patch.manufacturer;
    if (patch.model !== undefined) set.model = patch.model;
    if (patch.serialNumber !== undefined) set.serialNumber = patch.serialNumber;
    if (patch.year !== undefined) set.year = patch.year;
    if (patch.condition !== undefined) set.condition = patch.condition;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.clientId !== undefined) set.clientId = patch.clientId;
    if (patch.buyerClientId !== undefined) set.buyerClientId = patch.buyerClientId;
    if (patch.assetId !== undefined) set.assetId = patch.assetId;
    if (patch.purchasePriceKopecks !== undefined)
      set.purchasePriceKopecks = patch.purchasePriceKopecks;
    if (patch.assessedPriceKopecks !== undefined)
      set.assessedPriceKopecks = patch.assessedPriceKopecks;
    if (patch.salePriceKopecks !== undefined) set.salePriceKopecks = patch.salePriceKopecks;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.receivedAt !== undefined) set.receivedAt = patch.receivedAt;
    if (Object.keys(set).length === 0) {
      return getTradeInById(db, tenantId, id);
    }
    const updated = await tx
      .update(tradeInItems)
      .set(set)
      .where(and(eq(tradeInItems.id, id), isNull(tradeInItems.deletedAt)))
      .returning({ id: tradeInItems.id });
    if (!updated[0]) return null;
    return getTradeInById(db, tenantId, id);
  });
}

export async function archiveTradeIn(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(tradeInItems)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(tradeInItems.id, id), isNull(tradeInItems.deletedAt)))
      .returning({ id: tradeInItems.id });
    return updated.length > 0;
  });
}

/**
 * Завершение сделки: status→sold + soldAt=today (+ salePrice если передан),
 * и перенос владельца привязанного asset'а с событием owner_change.
 * Возвращает null если позиция не найдена.
 */
export async function completeTradeIn(
  db: Db,
  tenantId: string,
  id: string,
  opts: { salePriceKopecks?: bigint; actorUserId: string },
): Promise<TradeInDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(tradeInItems)
      .where(and(eq(tradeInItems.id, id), isNull(tradeInItems.deletedAt)))
      .limit(1);
    const item = rows[0];
    if (!item) return null;

    const today = new Date().toISOString().slice(0, 10);

    await tx
      .update(tradeInItems)
      .set({
        status: 'sold',
        soldAt: today,
        ...(opts.salePriceKopecks !== undefined
          ? { salePriceKopecks: opts.salePriceKopecks }
          : {}),
      })
      .where(eq(tradeInItems.id, id));

    // Перенос владельца техники (если привязана и владелец меняется).
    if (item.assetId && item.buyerClientId) {
      const assetRows = await tx
        .select({ id: assets.id, ownerClientId: assets.ownerClientId })
        .from(assets)
        .where(and(eq(assets.id, item.assetId), isNull(assets.deletedAt)))
        .limit(1);
      const asset = assetRows[0];
      if (asset && asset.ownerClientId !== item.buyerClientId) {
        await tx
          .update(assets)
          .set({ ownerClientId: item.buyerClientId })
          .where(eq(assets.id, item.assetId));
        await tx.insert(assetEvents).values({
          tenantId,
          assetId: item.assetId,
          userId: opts.actorUserId,
          type: 'owner_change',
          payload: {
            from: asset.ownerClientId,
            to: item.buyerClientId,
            comment: `Трейд-ин завершён: ${item.name}`,
          },
        });
      }
    }

    const after = await tx
      .select(joinedSelect)
      .from(tradeInItems)
      .leftJoin(sellerClients, eq(sellerClients.id, tradeInItems.clientId))
      .leftJoin(buyerClients, eq(buyerClients.id, tradeInItems.buyerClientId))
      .where(eq(tradeInItems.id, id))
      .limit(1);
    return after[0] ? rowToDto(after[0]) : null;
  });
}

/** Сводка по статусам + деньги (FILTER-агрегаты, один запрос). */
export async function tradeInStats(db: Db, tenantId: string): Promise<TradeInStats> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        received: sql<number>`count(*) FILTER (WHERE ${tradeInItems.status} = 'received')::int`,
        assessed: sql<number>`count(*) FILTER (WHERE ${tradeInItems.status} = 'assessed')::int`,
        inStock: sql<number>`count(*) FILTER (WHERE ${tradeInItems.status} = 'in_stock')::int`,
        sold: sql<number>`count(*) FILTER (WHERE ${tradeInItems.status} = 'sold')::int`,
        scrapped: sql<number>`count(*) FILTER (WHERE ${tradeInItems.status} = 'scrapped')::int`,
        investedKopecks: sql<string>`COALESCE(SUM(${tradeInItems.purchasePriceKopecks}) FILTER (WHERE ${tradeInItems.status} IN ('received','assessed','in_stock')), 0)::bigint::text`,
        soldRevenueKopecks: sql<string>`COALESCE(SUM(${tradeInItems.salePriceKopecks}) FILTER (WHERE ${tradeInItems.status} = 'sold'), 0)::bigint::text`,
        soldMarginKopecks: sql<string>`COALESCE(SUM(${tradeInItems.salePriceKopecks} - ${tradeInItems.purchasePriceKopecks}) FILTER (WHERE ${tradeInItems.status} = 'sold' AND ${tradeInItems.salePriceKopecks} IS NOT NULL), 0)::bigint::text`,
      })
      .from(tradeInItems)
      .where(isNull(tradeInItems.deletedAt));
    return (
      rows[0] ?? {
        received: 0,
        assessed: 0,
        inStock: 0,
        sold: 0,
        scrapped: 0,
        investedKopecks: '0',
        soldRevenueKopecks: '0',
        soldMarginKopecks: '0',
      }
    );
  });
}
