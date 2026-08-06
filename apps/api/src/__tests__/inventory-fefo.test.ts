/**
 * Тест на ядро Этапа 5: FEFO-выдача со склада в строку наряда.
 *
 * Сценарий:
 *   - 3 партии (qty 5 / 10 / 100, expires вчера / +10д / +30д)
 *   - issueToWorkOrder qty=12 → должна захватить:
 *     • всю первую партию (5)
 *     • 7 из второй партии (остаётся 3)
 *   - Третья партия не трогается.
 *   - Создаются 2 movement-записи, обе с reference_type='work_order_line'.
 *
 * Также проверяем, что при недостатке запаса бросается NotEnoughStockError.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  inventoryBatches,
  inventoryItems,
  inventoryMovements,
  tickets,
  withTenantTx,
  workOrderLines,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { NotEnoughStockError, issueToWorkOrder } from '../modules/inventory-movements/repository';

let erfolgId = '';
let primaryClientId = '';

const TEST_PREFIX = 'TEST-FEFO-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, async (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    // Удаляем в порядке: movements → batches → items, иначе RESTRICT FK блокирует.
    const testItems = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(like(inventoryItems.name, `${TEST_PREFIX}%`));
    for (const item of testItems) {
      await tx.delete(inventoryMovements).where(eq(inventoryMovements.itemId, item.id));
      await tx.delete(inventoryBatches).where(eq(inventoryBatches.itemId, item.id));
    }
    await tx.delete(inventoryItems).where(like(inventoryItems.name, `${TEST_PREFIX}%`));
  });
}

interface SetupResult {
  itemId: string;
  batchIds: { expired: string; mid: string; fresh: string };
  workOrderId: string;
  partLineId: string;
}

async function setup(): Promise<SetupResult> {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();

  return withTenantTx(getDb(), erfolgId, async (tx) => {
    const [item] = await tx
      .insert(inventoryItems)
      .values({
        tenantId: erfolgId,
        name: `${TEST_PREFIX}Sensor`,
        unit: 'шт',
        minStock: '0',
      })
      .returning({ id: inventoryItems.id });
    if (!item) throw new Error('test setup: item insert');

    const [b1] = await tx
      .insert(inventoryBatches)
      .values({
        tenantId: erfolgId,
        itemId: item.id,
        batchCode: 'EXP',
        quantityInitial: '5',
        quantityRemaining: '5',
        receivedAt: new Date(now - 60 * day),
        expiresAt: new Date(now - 1 * day),
      })
      .returning({ id: inventoryBatches.id });
    const [b2] = await tx
      .insert(inventoryBatches)
      .values({
        tenantId: erfolgId,
        itemId: item.id,
        batchCode: 'MID',
        quantityInitial: '10',
        quantityRemaining: '10',
        receivedAt: new Date(now - 30 * day),
        expiresAt: new Date(now + 10 * day),
      })
      .returning({ id: inventoryBatches.id });
    const [b3] = await tx
      .insert(inventoryBatches)
      .values({
        tenantId: erfolgId,
        itemId: item.id,
        batchCode: 'FRESH',
        quantityInitial: '100',
        quantityRemaining: '100',
        receivedAt: new Date(now - 5 * day),
        expiresAt: new Date(now + 30 * day),
      })
      .returning({ id: inventoryBatches.id });
    if (!b1 || !b2 || !b3) throw new Error('test setup: batch insert');

    return {
      itemId: item.id,
      batchIds: { expired: b1.id, mid: b2.id, fresh: b3.id },
      workOrderId: '',
      partLineId: '',
    };
  }).then(async (result) => {
    const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}base`,
    });
    const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
    const line = await upsertLine(getDb(), erfolgId, wo.id, null, {
      lineType: 'part',
      name: `${TEST_PREFIX}part`,
      unit: 'шт',
      quantity: '12',
      unitPriceKopecks: 0n,
    });
    return {
      ...result,
      workOrderId: wo.id,
      partLineId: line.id,
    };
  });
}

describe('FEFO выдача в строку наряда', () => {
  beforeEach(async () => {
    await clearTestData();
  });

  it('списывает партии в порядке expires_at NULLS LAST', async () => {
    const { itemId, batchIds, partLineId } = await setup();

    const result = await issueToWorkOrder(getDb(), erfolgId, {
      workOrderLineId: partLineId,
      itemId,
      quantity: '12',
      userId: null,
    });

    expect(result.consumed.length).toBe(2);
    expect(result.consumed[0]?.batchId).toBe(batchIds.expired);
    expect(result.consumed[0]?.quantity).toBe('5');
    expect(result.consumed[1]?.batchId).toBe(batchIds.mid);
    expect(result.consumed[1]?.quantity).toBe('7');

    // Проверяем остатки в партиях.
    const [b1] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ q: inventoryBatches.quantityRemaining })
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, batchIds.expired)),
    );
    const [b2] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ q: inventoryBatches.quantityRemaining })
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, batchIds.mid)),
    );
    const [b3] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ q: inventoryBatches.quantityRemaining })
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, batchIds.fresh)),
    );
    expect(Number(b1?.q)).toBe(0);
    expect(Number(b2?.q)).toBe(3);
    expect(Number(b3?.q)).toBe(100);

    // Проверяем что движения созданы и привязаны к строке наряда.
    const movements = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.itemId, itemId), eq(inventoryMovements.kind, 'outbound'))),
    );
    expect(movements.length).toBe(2);
    for (const m of movements) {
      expect(m.referenceType).toBe('work_order_line');
      expect(m.referenceId).toBe(partLineId);
    }

    // Строка наряда привязана к item.
    const [line] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ inventoryItemId: workOrderLines.inventoryItemId })
        .from(workOrderLines)
        .where(eq(workOrderLines.id, partLineId)),
    );
    expect(line?.inventoryItemId).toBe(itemId);
  });

  it('NULLS LAST: партии без expires_at уходят последними', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const { partLineId, itemId } = await withTenantTx(getDb(), erfolgId, async (tx) => {
      const [item] = await tx
        .insert(inventoryItems)
        .values({
          tenantId: erfolgId,
          name: `${TEST_PREFIX}NoExpiry`,
          unit: 'шт',
        })
        .returning({ id: inventoryItems.id });
      if (!item) throw new Error('item');
      // Партия без срока + партия со сроком
      await tx.insert(inventoryBatches).values([
        {
          tenantId: erfolgId,
          itemId: item.id,
          quantityInitial: '5',
          quantityRemaining: '5',
          receivedAt: new Date(now - 60 * day),
          expiresAt: null,
        },
        {
          tenantId: erfolgId,
          itemId: item.id,
          quantityInitial: '5',
          quantityRemaining: '5',
          receivedAt: new Date(now - 10 * day),
          expiresAt: new Date(now + 5 * day),
        },
      ]);
      return { itemId: item.id, partLineId: '' };
    }).then(async (r) => {
      const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
        clientId: primaryClientId,
        symptom: `${TEST_PREFIX}nullslast`,
      });
      const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
      const line = await upsertLine(getDb(), erfolgId, wo.id, null, {
        lineType: 'part',
        name: `${TEST_PREFIX}line`,
        unit: 'шт',
        quantity: '3',
        unitPriceKopecks: 0n,
      });
      return { ...r, partLineId: line.id };
    });

    const result = await issueToWorkOrder(getDb(), erfolgId, {
      workOrderLineId: partLineId,
      itemId,
      quantity: '3',
      userId: null,
    });

    // expectation: первая взятая партия — со сроком (NULL уходит последним).
    expect(result.consumed[0]?.expiresAt).not.toBeNull();
  });

  it('недостаточно остатков → NotEnoughStockError', async () => {
    const { itemId, partLineId } = await setup();

    await expect(
      issueToWorkOrder(getDb(), erfolgId, {
        workOrderLineId: partLineId,
        itemId,
        quantity: '999', // 5+10+100=115 < 999
        userId: null,
      }),
    ).rejects.toBeInstanceOf(NotEnoughStockError);

    // Партии не должны измениться.
    const remainingRows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ q: inventoryBatches.quantityRemaining })
        .from(inventoryBatches)
        .where(eq(inventoryBatches.itemId, itemId)),
    );
    const total = remainingRows.reduce((acc, r) => acc + Number(r.q), 0);
    expect(total).toBe(115);
  });

  it('возврат NotEnoughStockError: ничего не commit-ится (idempotent)', async () => {
    const { itemId, partLineId } = await setup();

    try {
      await issueToWorkOrder(getDb(), erfolgId, {
        workOrderLineId: partLineId,
        itemId,
        quantity: '999',
        userId: null,
      });
    } catch {
      /* expected */
    }

    // Не должно быть outbound-движений.
    const movements = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.itemId, itemId), eq(inventoryMovements.kind, 'outbound'))),
    );
    expect(movements.length).toBe(0);
  });
});
