/**
 * Repository для inventory_items — справочник товаров склада.
 *
 * list возвращает агрегированный остаток (sum quantity_remaining по item_id).
 * Удаление item с активными movements запрещаем на уровне service (409).
 */
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { ruIlike } from '../../lib/ru-search';
import { inventoryItems, inventoryMovements, withTenantTx, type Db } from '@erfolg/db';

export interface InventoryItemDto {
  id: string;
  name: string;
  sku: string | null;
  manufacturer: string | null;
  unit: string;
  /** numeric → string */
  minStock: string;
  /** Сумма quantity_remaining по всем партиям, numeric → string */
  totalRemaining: string;
  category: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListItemsOpts {
  search?: string;
  category?: string | null;
  /** Только с остатком < min_stock */
  lowStock?: boolean;
  page?: number;
  pageSize?: number;
}

export interface UpsertItemInput {
  name: string;
  sku?: string | null;
  manufacturer?: string | null;
  unit: string;
  minStock: string;
  category?: string | null;
  notes?: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function pageBounds(opts: ListItemsOpts): { limit: number; offset: number } {
  const pageSize = Math.min(opts.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const page = Math.max(opts.page ?? 1, 1);
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export async function listItems(
  db: Db,
  tenantId: string,
  opts: ListItemsOpts = {},
): Promise<{ items: InventoryItemDto[]; total: number }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const { limit, offset } = pageBounds(opts);
    // Раньше использовался Drizzle-template со ${inventoryItems.id}; вне явного alias
    // correlated reference иногда уходила в "inventory_items_1" из subquery-scope и SUM
    // считалась по 0 строкам. Переписали на raw SQL с явным "inventory_items"."id".
    const remainingExpr = sql<string>`COALESCE((
      SELECT SUM(b.quantity_remaining)::text
        FROM inventory_batches b
       WHERE b.item_id = "inventory_items"."id"
    ), '0')`;

    const conds = [];
    if (opts.search?.trim()) {
      const q = `%${opts.search.trim()}%`;
      conds.push(or(ruIlike(inventoryItems.name, q), ruIlike(inventoryItems.sku, q)));
    }
    if (opts.category) conds.push(eq(inventoryItems.category, opts.category));
    const whereExpr = conds.length > 0 ? and(...conds) : undefined;

    const baseRows = await tx
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        sku: inventoryItems.sku,
        manufacturer: inventoryItems.manufacturer,
        unit: inventoryItems.unit,
        minStock: inventoryItems.minStock,
        totalRemaining: remainingExpr,
        category: inventoryItems.category,
        notes: inventoryItems.notes,
        createdAt: inventoryItems.createdAt,
        updatedAt: inventoryItems.updatedAt,
      })
      .from(inventoryItems)
      .where(whereExpr)
      .orderBy(asc(inventoryItems.name))
      .limit(limit)
      .offset(offset);

    const filtered = opts.lowStock
      ? baseRows.filter((r) => Number(r.totalRemaining) < Number(r.minStock))
      : baseRows;

    const totalRows = await tx
      .select({ count: sql<string>`COUNT(*)` })
      .from(inventoryItems)
      .where(whereExpr);
    const total = Number(totalRows[0]?.count ?? '0');

    return { items: filtered, total };
  });
}

export async function getItem(
  db: Db,
  tenantId: string,
  itemId: string,
): Promise<InventoryItemDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const remainingExpr = sql<string>`COALESCE((
      SELECT SUM(b.quantity_remaining)::text
        FROM inventory_batches b
       WHERE b.item_id = "inventory_items"."id"
    ), '0')`;
    const rows = await tx
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        sku: inventoryItems.sku,
        manufacturer: inventoryItems.manufacturer,
        unit: inventoryItems.unit,
        minStock: inventoryItems.minStock,
        totalRemaining: remainingExpr,
        category: inventoryItems.category,
        notes: inventoryItems.notes,
        createdAt: inventoryItems.createdAt,
        updatedAt: inventoryItems.updatedAt,
      })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, itemId))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function createItem(
  db: Db,
  tenantId: string,
  input: UpsertItemInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(inventoryItems)
      .values({
        tenantId,
        name: input.name,
        sku: input.sku ?? null,
        manufacturer: input.manufacturer ?? null,
        unit: input.unit,
        minStock: input.minStock,
        category: input.category ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: inventoryItems.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error('createItem: insert returned nothing');
    return { id };
  });
}

export async function updateItem(
  db: Db,
  tenantId: string,
  itemId: string,
  patch: Partial<UpsertItemInput>,
): Promise<void> {
  const setObj: Record<string, unknown> = {};
  if (patch.name !== undefined) setObj.name = patch.name;
  if (patch.sku !== undefined) setObj.sku = patch.sku;
  if (patch.manufacturer !== undefined) setObj.manufacturer = patch.manufacturer;
  if (patch.unit !== undefined) setObj.unit = patch.unit;
  if (patch.minStock !== undefined) setObj.minStock = patch.minStock;
  if (patch.category !== undefined) setObj.category = patch.category;
  if (patch.notes !== undefined) setObj.notes = patch.notes;
  if (Object.keys(setObj).length === 0) return;
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.update(inventoryItems).set(setObj).where(eq(inventoryItems.id, itemId));
  });
}

export async function deleteItem(db: Db, tenantId: string, itemId: string): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.delete(inventoryItems).where(eq(inventoryItems.id, itemId));
  });
}

/** Проверка что у item есть movements (запрещаем удаление). */
export async function hasMovements(db: Db, tenantId: string, itemId: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.itemId, itemId))
      .limit(1);
    return rows.length > 0;
  });
}

/** Существует ли item в этом tenant — нужно для service-валидации. */
export async function itemExists(db: Db, tenantId: string, itemId: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, itemId))
      .limit(1);
    return rows.length > 0;
  });
}

/** Список последних N movements по item — для журнала на странице карточки. */
export async function listMovementsForItem(
  db: Db,
  tenantId: string,
  itemId: string,
  limit = 50,
): Promise<
  Array<{
    id: string;
    quantity: string;
    kind: string;
    referenceType: string;
    referenceId: string | null;
    batchId: string | null;
    userId: string | null;
    comment: string | null;
    createdAt: Date;
  }>
> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: inventoryMovements.id,
        quantity: inventoryMovements.quantity,
        kind: inventoryMovements.kind,
        referenceType: inventoryMovements.referenceType,
        referenceId: inventoryMovements.referenceId,
        batchId: inventoryMovements.batchId,
        userId: inventoryMovements.userId,
        comment: inventoryMovements.comment,
        createdAt: inventoryMovements.createdAt,
      })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.itemId, itemId))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(limit);
    return rows;
  });
}
