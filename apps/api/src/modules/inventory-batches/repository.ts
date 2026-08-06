/**
 * Repository для inventory_batches — партии прихода.
 *
 * createBatch: атомарно INSERT batch + INSERT inventory_movements (kind='inbound').
 * writeoffBatch: INSERT movement (kind='writeoff') + UPDATE remaining=0 в одной tx.
 * listByItem: партии конкретного item, FEFO-сортировка (NULLS LAST, received_at).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { inventoryBatches, inventoryMovements, withTenantTx, type Db } from '@erfolg/db';

export interface InventoryBatchDto {
  id: string;
  itemId: string;
  batchCode: string | null;
  /** numeric → string */
  quantityInitial: string;
  quantityRemaining: string;
  unitCostKopecks: string;
  supplier: string | null;
  receivedAt: Date;
  expiresAt: Date | null;
  notes: string | null;
  createdAt: Date;
}

export interface CreateBatchInput {
  itemId: string;
  batchCode?: string | null;
  /** numeric строка вида "12.345" */
  quantity: string;
  unitCostKopecks: bigint;
  supplier?: string | null;
  receivedAt?: Date;
  expiresAt?: Date | null;
  notes?: string | null;
}

function toDto(row: {
  id: string;
  itemId: string;
  batchCode: string | null;
  quantityInitial: string;
  quantityRemaining: string;
  unitCostKopecks: bigint;
  supplier: string | null;
  receivedAt: Date;
  expiresAt: Date | null;
  notes: string | null;
  createdAt: Date;
}): InventoryBatchDto {
  return { ...row, unitCostKopecks: row.unitCostKopecks.toString() };
}

export async function listBatchesByItem(
  db: Db,
  tenantId: string,
  itemId: string,
): Promise<InventoryBatchDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: inventoryBatches.id,
        itemId: inventoryBatches.itemId,
        batchCode: inventoryBatches.batchCode,
        quantityInitial: inventoryBatches.quantityInitial,
        quantityRemaining: inventoryBatches.quantityRemaining,
        unitCostKopecks: inventoryBatches.unitCostKopecks,
        supplier: inventoryBatches.supplier,
        receivedAt: inventoryBatches.receivedAt,
        expiresAt: inventoryBatches.expiresAt,
        notes: inventoryBatches.notes,
        createdAt: inventoryBatches.createdAt,
      })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.itemId, itemId))
      // FEFO-порядок: ASC NULLS LAST по expires_at, потом по receivedAt
      .orderBy(sql`${inventoryBatches.expiresAt} ASC NULLS LAST`, asc(inventoryBatches.receivedAt));
    return rows.map(toDto);
  });
}

export async function getBatch(
  db: Db,
  tenantId: string,
  batchId: string,
): Promise<InventoryBatchDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: inventoryBatches.id,
        itemId: inventoryBatches.itemId,
        batchCode: inventoryBatches.batchCode,
        quantityInitial: inventoryBatches.quantityInitial,
        quantityRemaining: inventoryBatches.quantityRemaining,
        unitCostKopecks: inventoryBatches.unitCostKopecks,
        supplier: inventoryBatches.supplier,
        receivedAt: inventoryBatches.receivedAt,
        expiresAt: inventoryBatches.expiresAt,
        notes: inventoryBatches.notes,
        createdAt: inventoryBatches.createdAt,
      })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, batchId))
      .limit(1);
    return rows[0] ? toDto(rows[0]) : null;
  });
}

/**
 * Создаёт партию + соответствующее inbound-движение в одной транзакции.
 * Quantity в movement положительная (приход).
 */
export async function createBatch(
  db: Db,
  tenantId: string,
  userId: string | null,
  input: CreateBatchInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(inventoryBatches)
      .values({
        tenantId,
        itemId: input.itemId,
        batchCode: input.batchCode ?? null,
        quantityInitial: input.quantity,
        quantityRemaining: input.quantity,
        unitCostKopecks: input.unitCostKopecks,
        supplier: input.supplier ?? null,
        receivedAt: input.receivedAt ?? new Date(),
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: inventoryBatches.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error('createBatch: insert returned nothing');

    await tx.insert(inventoryMovements).values({
      tenantId,
      itemId: input.itemId,
      batchId: id,
      quantity: input.quantity,
      kind: 'inbound',
      referenceType: 'manual',
      userId,
      comment: input.batchCode ? `Приход партии ${input.batchCode}` : null,
    });

    return { id };
  });
}

/**
 * Списание остатка партии (writeoff).
 * Если quantity_remaining > 0 — INSERT movement с отрицательной quantity, UPDATE remaining=0.
 * Если уже 0 — no-op.
 */
export async function writeoffBatch(
  db: Db,
  tenantId: string,
  userId: string | null,
  batchId: string,
  comment: string | null,
): Promise<{ writtenOff: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        itemId: inventoryBatches.itemId,
        quantityRemaining: inventoryBatches.quantityRemaining,
      })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, batchId))
      .for('update')
      .limit(1);
    const batch = rows[0];
    if (!batch) throw new Error('writeoffBatch: batch not found');
    if (Number(batch.quantityRemaining) <= 0) return { writtenOff: '0' };

    const negQty = `-${batch.quantityRemaining}`;
    await tx.insert(inventoryMovements).values({
      tenantId,
      itemId: batch.itemId,
      batchId,
      quantity: negQty,
      kind: 'writeoff',
      referenceType: 'manual',
      userId,
      comment,
    });
    await tx
      .update(inventoryBatches)
      .set({ quantityRemaining: '0' })
      .where(and(eq(inventoryBatches.id, batchId), eq(inventoryBatches.tenantId, tenantId)));
    return { writtenOff: batch.quantityRemaining };
  });
}
