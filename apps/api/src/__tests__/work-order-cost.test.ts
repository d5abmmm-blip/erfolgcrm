/**
 * Этап 8.C — себестоимость и маржа work_order:
 *   • work-строка: cost = процент инженера от цены работы × qty
 *     (раньше была часовая ставка; на бою работу пишут в «шт», а не в «час»)
 *   • part-строка БЕЗ inventory_item_id: cost = 0
 *   • part-строка с FEFO-выдачей: cost = weighted-avg unit_cost списанных партий × qty
 *   • expense-строка: cost = unit_price × qty (расход = себестоимость, маржа 0)
 *   • work_orders.cost_amount + margin_amount материализованы и пересчитываются
 *     при каждом upsertLine / deleteLine / FEFO-issue.
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
  users,
  withTenantTx,
  workOrderLines,
  workOrders,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import {
  deleteLine,
  getOrCreateWorkOrder,
  upsertLine,
} from '../modules/work-orders/repository';
import { issueToWorkOrder } from '../modules/inventory-movements/repository';

let erfolgId = '';
let primaryClientId = '';
let engineerId = '';

const TEST_PREFIX = 'TEST8C-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
  const [e] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'engineer')).limit(1),
  );
  if (!e) throw new Error('seed missing engineer');
  engineerId = e.id;
  // Часовую ставку больше НЕ трогаем: себестоимость работы считается процентом от
  // цены (см. payroll/resolveWorkPercent), колонка hourly_cost_rate ни на что не влияет.
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    // 1. Удаляем тикеты — каскадом уйдут work_orders/work_order_lines/invoices/payments.
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    // 2. Удаляем inventory: movements → batches → items (FK RESTRICT, иначе fail).
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
  });
}

async function freshOrder(): Promise<{ ticketId: string; workOrderId: string }> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}order`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  return { ticketId, workOrderId: wo.id };
}

async function selectTotals(workOrderId: string) {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({
        total: workOrders.totalAmountKopecks,
        cost: workOrders.costAmountKopecks,
        margin: workOrders.marginAmountKopecks,
      })
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId)),
  );
  return row;
}

describe('work-order cost & margin (8.C)', () => {
  beforeEach(clearTestData);

  it('work-строка с engineer: cost = доля ЦЕНЫ работы (процент инженера), margin = total - cost', async () => {
    const { workOrderId } = await freshOrder();
    // Две работы ОДНОГО инженера, вторая ровно вдвое дороже.
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}diag-1`,
      unit: 'шт',
      quantity: '2',
      unitPriceKopecks: 100_000n,
      engineerId,
    });
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}diag-2`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 200_000n,
      engineerId,
    });

    const lines = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(workOrderLines).where(eq(workOrderLines.workOrderId, workOrderId)),
    );
    const cheap = lines.find((l) => l.name.endsWith('diag-1'));
    const pricey = lines.find((l) => l.name.endsWith('diag-2'));
    if (!cheap || !pricey) throw new Error('work lines missing');

    // 🔴 СУТЬ ПРАВКИ: себестоимость зависит от ЦЕНЫ работы.
    // При старой часовой ставке обе строки стоили бы ОДИНАКОВО (ставка × 1),
    // и это равенство не выполнилось бы. Конкретный процент здесь намеренно не
    // фиксируем: payroll.test в beforeEach обнуляет payout_* у всех пользователей,
    // а vitest гоняет файлы параллельно — точные цифры проверены чистыми тестами
    // в labor-cost-percent.test.ts.
    expect(pricey.costPerUnitKopecks).toBe(cheap.costPerUnitKopecks * 2n);

    const t = await selectTotals(workOrderId);
    expect(t?.total).toBe(400_000n);
    expect(t?.cost).toBe(cheap.costPerUnitKopecks * 2n + pricey.costPerUnitKopecks);
    expect(t?.margin).toBe(400_000n - (t?.cost ?? 0n));
  });

  it('work-строка БЕЗ engineer: cost = 0, margin = total', async () => {
    const { workOrderId } = await freshOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}noeng`,
      unit: 'час',
      quantity: '1',
      unitPriceKopecks: 100_000n,
    });
    const t = await selectTotals(workOrderId);
    expect(t?.total).toBe(100_000n);
    expect(t?.cost).toBe(0n);
    expect(t?.margin).toBe(100_000n);
  });

  it('expense-строка: cost = unit_price × qty, margin = 0', async () => {
    const { workOrderId } = await freshOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'expense',
      name: `${TEST_PREFIX}taxi`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 50_000n,
    });
    const t = await selectTotals(workOrderId);
    expect(t?.total).toBe(50_000n);
    expect(t?.cost).toBe(50_000n);
    expect(t?.margin).toBe(0n);
  });

  it('part-строка БЕЗ inventory_item_id: cost = 0', async () => {
    const { workOrderId } = await freshOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'part',
      name: `${TEST_PREFIX}freepart`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 200_000n,
    });
    const t = await selectTotals(workOrderId);
    expect(t?.total).toBe(200_000n);
    expect(t?.cost).toBe(0n);
    expect(t?.margin).toBe(200_000n);
  });

  it('part-строка с FEFO-issue: cost = weighted-avg списанных партий × qty', async () => {
    const { workOrderId } = await freshOrder();
    // Item + 2 партии с разной ценой
    const itemRows = await withTenantTx(getDb(), erfolgId, async (tx) => {
      return tx
        .insert(inventoryItems)
        .values({ tenantId: erfolgId, name: `${TEST_PREFIX}part`, unit: 'шт' })
        .returning({ id: inventoryItems.id });
    });
    const itemId = itemRows[0]?.id;
    if (!itemId) throw new Error('item');
    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx.insert(inventoryBatches).values({
        tenantId: erfolgId,
        itemId,
        quantityInitial: '5',
        quantityRemaining: '5',
        unitCostKopecks: 100n,
        receivedAt: new Date('2026-01-01T00:00:00Z'),
      });
      await tx.insert(inventoryBatches).values({
        tenantId: erfolgId,
        itemId,
        quantityInitial: '5',
        quantityRemaining: '5',
        unitCostKopecks: 300n,
        receivedAt: new Date('2026-01-02T00:00:00Z'),
      });
    });
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'part',
      name: `${TEST_PREFIX}part`,
      unit: 'шт',
      quantity: '8',
      unitPriceKopecks: 1_000n,
    });
    const lineRows = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx
        .select({ id: workOrderLines.id })
        .from(workOrderLines)
        .where(eq(workOrderLines.workOrderId, workOrderId)),
    );
    const lineId = lineRows[0]?.id;
    if (!lineId) throw new Error('line');
    // FEFO: возьмёт 5×100 + 3×300 = 1400, wavg = 175
    await issueToWorkOrder(getDb(), erfolgId, {
      workOrderLineId: lineId,
      itemId,
      quantity: '8',
      userId: null,
    });
    const t = await selectTotals(workOrderId);
    expect(t?.total).toBe(8_000n);
    expect(t?.cost).toBe(1_400n);
    expect(t?.margin).toBe(6_600n);
  });

  it('deleteLine пересчитывает cost', async () => {
    const { workOrderId } = await freshOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}w1`,
      unit: 'час',
      quantity: '1',
      unitPriceKopecks: 100_000n,
      engineerId,
    });
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'expense',
      name: `${TEST_PREFIX}exp1`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 30_000n,
    });
    const lines = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(workOrderLines).where(eq(workOrderLines.workOrderId, workOrderId)),
    );
    const workLine = lines.find((l) => l.lineType === 'work');
    const expLine = lines.find((l) => l.lineType === 'expense');
    if (!workLine || !expLine) throw new Error('lines missing');
    // Себестоимость работы берём из самой строки — она зависит от процента инженера,
    // фиксировать её числом нельзя (см. пояснение выше).
    const workCost = workLine.costPerUnitKopecks;

    const before = await selectTotals(workOrderId);
    expect(before?.cost).toBe(workCost + 30_000n);
    expect(before?.margin).toBe(130_000n - (before?.cost ?? 0n));

    await deleteLine(getDb(), erfolgId, workOrderId, expLine.id);

    const after = await selectTotals(workOrderId);
    expect(after?.cost).toBe(workCost);
    expect(after?.margin).toBe(100_000n - workCost);
  });
});
