/**
 * Правка строки наряда не должна стирать то, чего в запросе нет.
 *
 * `WorkOrderEditor` (и десктоп, и мобилка, и списание со склада) шлёт при
 * сохранении только name/unit/quantity/unitPriceRub. Раньше `upsertLine`
 * перезаписывал строку ЦЕЛИКОМ, поэтому каждая правка молча стирала:
 *   • себестоимость запчасти — её проставляет выдача со склада, и это
 *     единственный её источник (восстановить неоткуда, в inventory_movements
 *     денежных колонок нет) → «Рентабельность» показывала маржу выше реальной;
 *   • инженера строки — ведомость ЗП считает сделку по
 *     COALESCE(wol.engineer_id, wo.engineer_id), то есть заработок молча
 *     переезжал на главного исполнителя наряда;
 *   • комментарий строки.
 *
 * Обратная сторона: пересчитывать себестоимость «по текущему состоянию» тоже
 * нельзя — склад и ставки инженеров сегодня другие, чем были. Поэтому снимок
 * сохраняется, а пересчёт происходит только когда пользователь сам сообщил
 * что-то, от чего себестоимость зависит.
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
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
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { issueToWorkOrder } from '../modules/inventory-movements/repository';

let erfolgId = '';
let primaryClientId = '';
let engineerA = '';
let engineerB = '';
let originalRates: Array<{ id: string; rate: bigint }> = [];

const TEST_PREFIX = 'TESTEDIT-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;

  // Роль тут не важна: resolveLineCost читает ставку по id пользователя.
  const staff = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, rate: users.hourlyCostRateKopecks }).from(users).limit(2),
  );
  if (staff.length < 2) throw new Error('seed needs 2 users');
  engineerA = staff[0]!.id;
  engineerB = staff[1]!.id;
  originalRates = staff.map((u) => ({ id: u.id, rate: u.rate }));
  // Разные ставки — чтобы отличать «пересчитали» от «сохранили».
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.update(users).set({ hourlyCostRateKopecks: 40_000n }).where(eq(users.id, engineerA));
    await tx.update(users).set({ hourlyCostRateKopecks: 70_000n }).where(eq(users.id, engineerB));
  });
});

afterAll(async () => {
  await clearTestData();
  // Ставки — общие данные, возвращаем как были, чтобы не влиять на соседние файлы.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    for (const u of originalRates) {
      await tx.update(users).set({ hourlyCostRateKopecks: u.rate }).where(eq(users.id, u.id));
    }
  });
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
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
beforeEach(clearTestData);

async function freshOrder(): Promise<string> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}order`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  return wo.id;
}

async function readLine(lineId: string) {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({
        cost: workOrderLines.costPerUnitKopecks,
        engineerId: workOrderLines.engineerId,
        comment: workOrderLines.comment,
        inventoryItemId: workOrderLines.inventoryItemId,
      })
      .from(workOrderLines)
      .where(eq(workOrderLines.id, lineId)),
  );
  return row;
}

async function readOrderCost(workOrderId: string) {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ cost: workOrders.costAmountKopecks, margin: workOrders.marginAmountKopecks })
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId)),
  );
  return row;
}

/** Запчасть, выданная со склада: две партии по разной цене, FEFO-списание. */
async function partIssuedFromStock(
  workOrderId: string,
  quantity: string,
): Promise<{ lineId: string; itemId: string }> {
  const [item] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .insert(inventoryItems)
      .values({ tenantId: erfolgId, name: `${TEST_PREFIX}part`, unit: 'шт' })
      .returning({ id: inventoryItems.id }),
  );
  const itemId = item!.id;
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
  // Так делает IssueFromInventory: сначала строка с ценой 0, потом списание.
  const line = await upsertLine(getDb(), erfolgId, workOrderId, null, {
    lineType: 'part',
    name: `${TEST_PREFIX}part`,
    unit: 'шт',
    quantity,
    unitPriceKopecks: 0n,
  });
  await issueToWorkOrder(getDb(), erfolgId, {
    workOrderLineId: line.id,
    itemId,
    quantity,
    userId: null,
  });
  return { lineId: line.id, itemId };
}

/** Payload ровно такой, какой шлёт WorkOrderEditor: инженера и комментария нет. */
function webPatch(over: {
  lineType: 'work' | 'part' | 'expense';
  name: string;
  quantity: string;
  unitPriceKopecks: bigint;
}) {
  return { unit: 'шт', ...over };
}

describe('правка строки наряда: себестоимость запчасти', () => {
  it('после выдачи со склада ввод цены НЕ обнуляет себестоимость', async () => {
    const workOrderId = await freshOrder();
    const { lineId } = await partIssuedFromStock(workOrderId, '8');

    const afterIssue = await readLine(lineId);
    expect(afterIssue?.cost).toBe(175n); // (5×100 + 3×300) / 8

    // Менеджер вписывает продажную цену — это обычный upsertLine из веба.
    await upsertLine(
      getDb(),
      erfolgId,
      workOrderId,
      lineId,
      webPatch({
        lineType: 'part',
        name: `${TEST_PREFIX}part`,
        quantity: '8',
        unitPriceKopecks: 1_000n,
      }),
    );

    const afterEdit = await readLine(lineId);
    expect(afterEdit?.cost).toBe(175n);
    expect(afterEdit?.inventoryItemId).toBeTruthy();

    const totals = await readOrderCost(workOrderId);
    expect(totals?.cost).toBe(1_400n); // 175 × 8
    expect(totals?.margin).toBe(8_000n - 1_400n);
  });

  it('переименование строки себестоимость не трогает', async () => {
    const workOrderId = await freshOrder();
    const { lineId } = await partIssuedFromStock(workOrderId, '8');

    await upsertLine(
      getDb(),
      erfolgId,
      workOrderId,
      lineId,
      webPatch({
        lineType: 'part',
        name: `${TEST_PREFIX}другое имя`,
        quantity: '8',
        unitPriceKopecks: 0n,
      }),
    );

    expect((await readLine(lineId))?.cost).toBe(175n);
  });
});

describe('правка строки наряда: инженер и комментарий', () => {
  it('правка из веба НЕ стирает инженера строки (сделка не переезжает)', async () => {
    const workOrderId = await freshOrder();
    const line = await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}работа`,
      unit: 'час',
      quantity: '2',
      unitPriceKopecks: 100_000n,
      engineerId: engineerA,
      comment: 'важное примечание',
    });

    const before = await readLine(line.id);
    expect(before?.engineerId).toBe(engineerA);

    // Веб шлёт только имя/количество/цену. Цена НЕ меняется → себестоимость единицы
    // остаётся прежней (пересчитывать нечего).
    await upsertLine(
      getDb(),
      erfolgId,
      workOrderId,
      line.id,
      webPatch({
        lineType: 'work',
        name: `${TEST_PREFIX}работа`,
        quantity: '3',
        unitPriceKopecks: 100_000n,
      }),
    );

    const after = await readLine(line.id);
    expect(after?.engineerId).toBe(engineerA);
    expect(after?.comment).toBe('важное примечание');
    expect(after?.cost).toBe(before?.cost);
  });

  it('правка ТОЛЬКО цены пересчитывает себестоимость работы (она — процент от цены)', async () => {
    const workOrderId = await freshOrder();
    const line = await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}работа`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 100_000n,
      engineerId: engineerA,
    });
    const before = await readLine(line.id);

    // Менеджер поправил цену вдвое. Инженера веб не шлёт вовсе.
    await upsertLine(
      getDb(),
      erfolgId,
      workOrderId,
      line.id,
      webPatch({
        lineType: 'work',
        name: `${TEST_PREFIX}работа`,
        quantity: '1',
        unitPriceKopecks: 200_000n,
      }),
    );

    const after = await readLine(line.id);
    // 🔴 БЕЗ пересчёта себестоимость осталась бы от прежней цены и маржа поехала бы.
    expect(after?.cost).toBe((before?.cost ?? 0n) * 2n);
    // И инженер строки при этом НЕ должен потеряться.
    expect(after?.engineerId).toBe(engineerA);
  });

  it('явно присланный другой инженер записывается, себестоимость пересчитывается', async () => {
    const workOrderId = await freshOrder();
    const line = await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}работа`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 100_000n,
      engineerId: engineerA,
    });
    const before = await readLine(line.id);

    // Сменили исполнителя И цену разом.
    await upsertLine(getDb(), erfolgId, workOrderId, line.id, {
      lineType: 'work',
      name: `${TEST_PREFIX}работа`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 200_000n,
      engineerId: engineerB,
    });

    const after = await readLine(line.id);
    expect(after?.engineerId).toBe(engineerB);
    // Себестоимость пересчитана от новой цены. Точный процент здесь не фиксируем:
    // у A и B он одинаков, пока не заданы личные правила, а payroll.test их обнуляет
    // параллельно — цифры проверены чистыми тестами labor-cost-percent.test.ts.
    expect(after?.cost).toBe((before?.cost ?? 0n) * 2n);
  });

  it('явный null инженера — сбрасывает и его, и себестоимость', async () => {
    const workOrderId = await freshOrder();
    const line = await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}работа`,
      unit: 'час',
      quantity: '1',
      unitPriceKopecks: 100_000n,
      engineerId: engineerA,
    });

    await upsertLine(getDb(), erfolgId, workOrderId, line.id, {
      lineType: 'work',
      name: `${TEST_PREFIX}работа`,
      unit: 'час',
      quantity: '1',
      unitPriceKopecks: 100_000n,
      engineerId: null,
    });

    const after = await readLine(line.id);
    expect(after?.engineerId).toBeNull();
    expect(after?.cost).toBe(0n);
  });
});

describe('правка строки наряда: расход и смена типа', () => {
  it('у расхода себестоимость следует за ценой (маржа остаётся нулевой)', async () => {
    const workOrderId = await freshOrder();
    const line = await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'expense',
      name: `${TEST_PREFIX}расход`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 5_000n,
    });
    expect((await readLine(line.id))?.cost).toBe(5_000n);

    await upsertLine(
      getDb(),
      erfolgId,
      workOrderId,
      line.id,
      webPatch({
        lineType: 'expense',
        name: `${TEST_PREFIX}расход`,
        quantity: '1',
        unitPriceKopecks: 9_000n,
      }),
    );

    expect((await readLine(line.id))?.cost).toBe(9_000n);
    expect((await readOrderCost(workOrderId))?.margin).toBe(0n);
  });

  it('смена типа строки — снимок не переносится', async () => {
    const workOrderId = await freshOrder();
    const line = await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'expense',
      name: `${TEST_PREFIX}было расходом`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 5_000n,
    });
    expect((await readLine(line.id))?.cost).toBe(5_000n);

    await upsertLine(
      getDb(),
      erfolgId,
      workOrderId,
      line.id,
      webPatch({
        lineType: 'part',
        name: `${TEST_PREFIX}стало запчастью`,
        quantity: '1',
        unitPriceKopecks: 5_000n,
      }),
    );

    // Запчасть без выдачи со склада себестоимости не имеет — 5000 от расхода
    // тут были бы выдумкой.
    expect((await readLine(line.id))?.cost).toBe(0n);
  });
});
