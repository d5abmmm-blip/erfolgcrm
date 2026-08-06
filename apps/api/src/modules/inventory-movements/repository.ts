/**
 * Repository для inventory_movements + ядро FEFO-выдачи.
 *
 * issueToWorkOrder: атомарная мульти-batch выдача.
 *   1. SELECT FOR UPDATE inventory_batches WHERE quantity_remaining > 0
 *      ORDER BY expires_at NULLS LAST, received_at — FEFO порядок.
 *      Используется индекс inventory_batches_fefo_idx.
 *   2. Распределяем нужное количество по партиям.
 *   3. Если суммарно не хватает — throw NOT_ENOUGH_STOCK (router конвертирует в TRPCError).
 *   4. INSERT по inventory_movements (по записи на партию, kind='outbound', знак отрицательный).
 *   5. UPDATE batch.quantity_remaining = old - taken для каждой.
 *   6. UPDATE work_order_lines.inventory_item_id если ещё не выставлен.
 *
 * Все операции в одной транзакции через withTenantTx → защита от race conditions
 * + автоматическое снятие блокировок при rollback.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  inventoryBatches,
  inventoryMovements,
  withTenantTx,
  workOrderLines,
  type Db,
} from '@erfolg/db';
import { recalcWorkOrderCostFromLines, sumLineCostKopecks } from '../work-orders/repository';

export class NotEnoughStockError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly requested: string,
    public readonly available: string,
  ) {
    super(`NOT_ENOUGH_STOCK: requested ${requested}, available ${available}`);
    this.name = 'NotEnoughStockError';
  }
}

export interface IssueToWorkOrderInput {
  workOrderLineId: string;
  itemId: string;
  /** numeric строка вида "1.500" */
  quantity: string;
  /** Кто провёл — для аудита и user_id в movement. */
  userId: string | null;
  comment?: string | null;
}

export interface IssueResult {
  consumed: Array<{
    batchId: string;
    quantity: string;
    expiresAt: Date | null;
  }>;
}

/**
 * Преобразование numeric-строки в bigint thousandths (3 знака после запятой).
 * Нужно чтобы корректно складывать дробные количества без float-ошибок.
 */
function toThousandths(quantity: string): bigint {
  const trimmed = quantity.trim();
  const negative = trimmed.startsWith('-');
  const raw = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracRaw = ''] = raw.split('.');
  const frac = (fracRaw + '000').slice(0, 3);
  const v = BigInt(`${intPart}${frac}`);
  return negative ? -v : v;
}

function fromThousandths(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const int = abs / 1000n;
  const frac = abs % 1000n;
  const fracStr = frac.toString().padStart(3, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fracStr.length > 0 ? `${sign}${int}.${fracStr}` : `${sign}${int}`;
}

export async function issueToWorkOrder(
  db: Db,
  tenantId: string,
  input: IssueToWorkOrderInput,
): Promise<IssueResult> {
  const requestedT = toThousandths(input.quantity);
  if (requestedT <= 0n) {
    throw new Error('issueToWorkOrder: quantity must be > 0');
  }

  return withTenantTx(db, tenantId, async (tx) => {
    // FEFO: SELECT FOR UPDATE — блокирует строки до конца транзакции.
    // ORDER BY expires_at NULLS LAST, received_at: партии без срока — последние.
    const batches = await tx
      .select({
        id: inventoryBatches.id,
        quantityRemaining: inventoryBatches.quantityRemaining,
        unitCostKopecks: inventoryBatches.unitCostKopecks,
        expiresAt: inventoryBatches.expiresAt,
        receivedAt: inventoryBatches.receivedAt,
      })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.itemId, input.itemId),
          sql`${inventoryBatches.quantityRemaining} > 0`,
        ),
      )
      .orderBy(
        sql`${inventoryBatches.expiresAt} ASC NULLS LAST`,
        sql`${inventoryBatches.receivedAt} ASC`,
      )
      .for('update');

    let remaining = requestedT;
    const consumed: IssueResult['consumed'] = [];
    const updates: Array<{
      batchId: string;
      newRemaining: bigint;
      takenT: bigint;
      unitCost: bigint;
    }> = [];

    for (const batch of batches) {
      if (remaining <= 0n) break;
      const availableT = toThousandths(batch.quantityRemaining);
      const takeT = availableT < remaining ? availableT : remaining;
      const newRemaining = availableT - takeT;
      updates.push({
        batchId: batch.id,
        newRemaining,
        takenT: takeT,
        unitCost: batch.unitCostKopecks,
      });
      consumed.push({
        batchId: batch.id,
        quantity: fromThousandths(takeT),
        expiresAt: batch.expiresAt,
      });
      remaining -= takeT;
    }

    if (remaining > 0n) {
      const totalAvailable = batches.reduce(
        (acc, b) => acc + toThousandths(b.quantityRemaining),
        0n,
      );
      throw new NotEnoughStockError(input.itemId, input.quantity, fromThousandths(totalAvailable));
    }

    // Применяем UPDATE по каждой партии и INSERT в movements.
    for (const u of updates) {
      await tx
        .update(inventoryBatches)
        .set({ quantityRemaining: fromThousandths(u.newRemaining) })
        .where(and(eq(inventoryBatches.id, u.batchId), eq(inventoryBatches.tenantId, tenantId)));
      await tx.insert(inventoryMovements).values({
        tenantId,
        itemId: input.itemId,
        batchId: u.batchId,
        // outbound — отрицательная quantity (учётная нотация).
        quantity: `-${fromThousandths(u.takenT)}`,
        kind: 'outbound',
        referenceType: 'work_order_line',
        referenceId: input.workOrderLineId,
        userId: input.userId,
        comment: input.comment ?? null,
      });
    }

    // 8.C: weighted-avg unit_cost по фактически списанным партиям.
    // Формула: SUM(takeT × unitCost) / SUM(takeT). Округление до целой копейки.
    let costNumerator = 0n;
    let costDenominator = 0n;
    for (const u of updates) {
      costNumerator += u.unitCost * u.takenT;
      costDenominator += u.takenT;
    }
    const costPerUnit =
      costDenominator > 0n ? (costNumerator + costDenominator / 2n) / costDenominator : 0n;

    // Наряд строки и снимок «несли ли строки себестоимость» ДО правки — нужны, чтобы
    // пересчёт не стёр историческую себестоимость импортированного наряда.
    const [woRow] = await tx
      .select({ workOrderId: workOrderLines.workOrderId, tenantId: workOrderLines.tenantId })
      .from(workOrderLines)
      .where(eq(workOrderLines.id, input.workOrderLineId))
      .limit(1);
    const lineCostBefore = woRow ? await sumLineCostKopecks(tx, woRow.workOrderId) : 0n;

    // Привязываем item к строке наряда + snapshot cost (8.C).
    await tx
      .update(workOrderLines)
      .set({ inventoryItemId: input.itemId, costPerUnitKopecks: costPerUnit })
      .where(eq(workOrderLines.id, input.workOrderLineId));

    // Пересчёт cost_amount/margin наряда — общей функцией, с защитой импортированной
    // себестоимости (раньше здесь был свой SQL мимо всякой защиты).
    if (woRow) {
      await recalcWorkOrderCostFromLines(tx, woRow.tenantId, woRow.workOrderId, lineCostBefore);
    }

    return { consumed };
  });
}

export interface ReturnFromWorkOrderInput {
  workOrderLineId: string;
  itemId: string;
  /** numeric строка вида "1.000" — сколько вернуть. */
  quantity: string;
  /** Куда возвращать. Если null — добавляется в самую свежую партию (последний received_at). */
  batchId?: string | null;
  userId: string | null;
  comment?: string | null;
}

export interface ReturnResult {
  batchId: string;
  newRemaining: string;
}

/**
 * Возврат запчасти со списания обратно на склад.
 * Не «сторнирует» исходный outbound-движений; создаёт inbound-движение к выбранной партии.
 * Это сохраняет историю: видно, что была выдана и возвращена.
 */
export async function returnFromWorkOrder(
  db: Db,
  tenantId: string,
  input: ReturnFromWorkOrderInput,
): Promise<ReturnResult> {
  const qtyT = toThousandths(input.quantity);
  if (qtyT <= 0n) throw new Error('returnFromWorkOrder: quantity must be > 0');

  return withTenantTx(db, tenantId, async (tx) => {
    // Берём целевую партию и блокируем её одним SELECT FOR UPDATE — без второго запроса.
    // Раньше была race: SELECT id ORDER BY received_at без блокировки → вернул ID,
    // другой tx insert новой партии (или delete) → второй SELECT FOR UPDATE по этому id
    // возвращал stale row или null. Теперь — один запрос, лок берётся сразу.
    let batch:
      | {
          id: string;
          quantityInitial: string;
          quantityRemaining: string;
        }
      | undefined;
    if (input.batchId) {
      const locked = await tx
        .select({
          id: inventoryBatches.id,
          quantityInitial: inventoryBatches.quantityInitial,
          quantityRemaining: inventoryBatches.quantityRemaining,
        })
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, input.batchId))
        .for('update')
        .limit(1);
      batch = locked[0];
    } else {
      const locked = await tx
        .select({
          id: inventoryBatches.id,
          quantityInitial: inventoryBatches.quantityInitial,
          quantityRemaining: inventoryBatches.quantityRemaining,
        })
        .from(inventoryBatches)
        .where(eq(inventoryBatches.itemId, input.itemId))
        .orderBy(desc(inventoryBatches.receivedAt))
        .for('update')
        .limit(1);
      batch = locked[0];
    }
    if (!batch) {
      throw new Error('returnFromWorkOrder: no batch to return into — приёмки этой позиции нет');
    }
    const targetBatchId = batch.id;

    const newRemainingT = toThousandths(batch.quantityRemaining) + qtyT;
    const initialT = toThousandths(batch.quantityInitial);
    if (newRemainingT > initialT) {
      // Не превышаем quantity_initial: возвращаемое поверх свободного места может
      // нарушить CHECK quantity_remaining <= quantity_initial. В этом случае надо
      // разделить возврат на несколько партий — пока возвращаем 409.
      throw new Error('RETURN_EXCEEDS_BATCH_INITIAL');
    }
    await tx
      .update(inventoryBatches)
      .set({ quantityRemaining: fromThousandths(newRemainingT) })
      .where(and(eq(inventoryBatches.id, targetBatchId), eq(inventoryBatches.tenantId, tenantId)));
    await tx.insert(inventoryMovements).values({
      tenantId,
      itemId: input.itemId,
      batchId: targetBatchId,
      quantity: fromThousandths(qtyT),
      kind: 'inbound',
      referenceType: 'work_order_line',
      referenceId: input.workOrderLineId,
      userId: input.userId,
      comment: input.comment ?? 'Возврат на склад',
    });
    return { batchId: targetBatchId, newRemaining: fromThousandths(newRemainingT) };
  });
}

export interface ListMovementsOpts {
  itemId?: string;
  kind?: 'inbound' | 'outbound' | 'adjustment' | 'writeoff';
  limit?: number;
}

export async function listMovements(db: Db, tenantId: string, opts: ListMovementsOpts) {
  return withTenantTx(db, tenantId, async (tx) => {
    const conds = [];
    if (opts.itemId) conds.push(eq(inventoryMovements.itemId, opts.itemId));
    if (opts.kind) conds.push(eq(inventoryMovements.kind, opts.kind));
    const whereExpr = conds.length > 0 ? and(...conds) : undefined;

    const rows = await tx
      .select({
        id: inventoryMovements.id,
        itemId: inventoryMovements.itemId,
        batchId: inventoryMovements.batchId,
        quantity: inventoryMovements.quantity,
        kind: inventoryMovements.kind,
        referenceType: inventoryMovements.referenceType,
        referenceId: inventoryMovements.referenceId,
        userId: inventoryMovements.userId,
        comment: inventoryMovements.comment,
        createdAt: inventoryMovements.createdAt,
      })
      .from(inventoryMovements)
      .where(whereExpr)
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(opts.limit ?? 100);
    return rows;
  });
}
