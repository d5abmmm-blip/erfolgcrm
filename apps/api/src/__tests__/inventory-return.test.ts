/**
 * Этап 6 — возврат запчасти со списания обратно на склад.
 *
 * Сценарий:
 *   1. Создаём item + батч 5 шт.
 *   2. Списываем 3 шт через FEFO → quantity_remaining = 2.
 *   3. Возвращаем 2 шт → quantity_remaining = 4.
 *   4. Возврат сверх quantity_initial → ошибка RETURN_EXCEEDS_BATCH_INITIAL.
 *   5. Без батчей вообще → ошибка no batch to return into.
 *   6. Cross-tenant: невозможно вернуть в чужой item (itemExists вернёт false на уровне service).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  inventoryBatches,
  inventoryItems,
  inventoryMovements,
  tickets,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { issueToWorkOrder, returnFromWorkOrder } from '../modules/inventory-movements/repository';

let erfolgId = '';
let primaryClientId = '';
const TEST_PREFIX = 'TEST-RET-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    const itemIds = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(like(inventoryItems.name, `${TEST_PREFIX}%`));
    if (itemIds.length > 0) {
      const ids = itemIds.map((r) => r.id);
      await tx.delete(inventoryMovements).where(inArray(inventoryMovements.itemId, ids));
      await tx.delete(inventoryBatches).where(inArray(inventoryBatches.itemId, ids));
      await tx.delete(inventoryItems).where(inArray(inventoryItems.id, ids));
    }
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}

async function setupItemAndLine(
  initialQty: string,
  batchCode: string,
): Promise<{
  itemId: string;
  batchId: string;
  workOrderLineId: string;
}> {
  const itemId = await withTenantTx(getDb(), erfolgId, async (tx) => {
    const [r] = await tx
      .insert(inventoryItems)
      .values({ tenantId: erfolgId, name: `${TEST_PREFIX}item`, unit: 'шт', minStock: '0' })
      .returning({ id: inventoryItems.id });
    if (!r) throw new Error('item insert failed');
    return r.id;
  });
  const batchId = await withTenantTx(getDb(), erfolgId, async (tx) => {
    const [r] = await tx
      .insert(inventoryBatches)
      .values({
        tenantId: erfolgId,
        itemId,
        batchCode: `${TEST_PREFIX}${batchCode}`,
        quantityInitial: initialQty,
        quantityRemaining: initialQty,
      })
      .returning({ id: inventoryBatches.id });
    if (!r) throw new Error('batch insert failed');
    return r.id;
  });
  const ticket = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}t`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticket.id);
  const line = await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'part',
    name: `${TEST_PREFIX}part`,
    unit: 'шт',
    quantity: '0',
    unitPriceKopecks: 0n,
  });
  return { itemId, batchId, workOrderLineId: line.id };
}

async function getRemaining(batchId: string): Promise<string> {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ q: inventoryBatches.quantityRemaining })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, batchId)),
  );
  return row?.q ?? '0';
}

describe('inventory return: возврат запчасти со списания', () => {
  beforeEach(async () => {
    await clearTestData();
  });

  it('issue 3 + return 2 → remaining 5-3+2 = 4', async () => {
    const { itemId, batchId, workOrderLineId } = await setupItemAndLine('5', 'b1');
    await issueToWorkOrder(getDb(), erfolgId, {
      workOrderLineId,
      itemId,
      quantity: '3',
      userId: null,
    });
    expect(await getRemaining(batchId)).toBe('2.000');
    await returnFromWorkOrder(getDb(), erfolgId, {
      workOrderLineId,
      itemId,
      quantity: '2',
      userId: null,
    });
    expect(await getRemaining(batchId)).toBe('4.000');
  });

  it('возврат сверх quantity_initial → RETURN_EXCEEDS_BATCH_INITIAL', async () => {
    const { itemId, workOrderLineId } = await setupItemAndLine('3', 'b2');
    // ничего не списали, пытаемся вернуть 1 — overflow.
    await expect(
      returnFromWorkOrder(getDb(), erfolgId, {
        workOrderLineId,
        itemId,
        quantity: '1',
        userId: null,
      }),
    ).rejects.toThrow('RETURN_EXCEEDS_BATCH_INITIAL');
  });

  it('возврат когда батчей нет → ошибка', async () => {
    const itemId = await withTenantTx(getDb(), erfolgId, async (tx) => {
      const [r] = await tx
        .insert(inventoryItems)
        .values({ tenantId: erfolgId, name: `${TEST_PREFIX}empty`, unit: 'шт', minStock: '0' })
        .returning({ id: inventoryItems.id });
      if (!r) throw new Error('item insert');
      return r.id;
    });
    const ticket = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}t-empty`,
    });
    const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticket.id);
    const line = await upsertLine(getDb(), erfolgId, wo.id, null, {
      lineType: 'part',
      name: `${TEST_PREFIX}part-empty`,
      unit: 'шт',
      quantity: '0',
      unitPriceKopecks: 0n,
    });
    await expect(
      returnFromWorkOrder(getDb(), erfolgId, {
        workOrderLineId: line.id,
        itemId,
        quantity: '1',
        userId: null,
      }),
    ).rejects.toThrow(/no batch to return/i);
  });

  it('inbound-движение записано с reference_type=work_order_line', async () => {
    const { itemId, batchId, workOrderLineId } = await setupItemAndLine('10', 'b3');
    await issueToWorkOrder(getDb(), erfolgId, {
      workOrderLineId,
      itemId,
      quantity: '4',
      userId: null,
    });
    await returnFromWorkOrder(getDb(), erfolgId, {
      workOrderLineId,
      itemId,
      quantity: '4',
      userId: null,
      comment: `${TEST_PREFIX}c1`,
    });
    const movements = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(inventoryMovements).where(eq(inventoryMovements.itemId, itemId)),
    );
    const inbound = movements.filter((m) => m.kind === 'inbound');
    expect(
      inbound.some((m) => m.referenceType === 'work_order_line' && m.batchId === batchId),
    ).toBe(true);
  });
});
