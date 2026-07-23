/**
 * Защита себестоимости импортированных нарядов.
 *
 * ОТКУДА БАГ. Наряды из старой системы (WinServisePro) хранят себестоимость в ШАПКЕ
 * наряда (`import-winservice.ts` кладёт `EXPENSESSUM` в `cost_amount_kopecks`), а у строк
 * себестоимость не заполнена вовсе — старая программа её по строкам не вела.
 * `recalcTotals` же всегда переписывает шапку суммой по строкам. Значит правка ЛЮБОЙ
 * строки такого наряда молча обнуляла историческую себестоимость, а вместе с ней —
 * маржу в отчёте «Рентабельность» и плитке «Маржа».
 * На боевой базе это 22 наряда на 137 056 ₽ — и это ВСЯ себестоимость, какая есть
 * в системе. Повреждено пока 0, но защиты не было никакой.
 *
 * ЧТО ИМЕННО ЗАЩИЩАЕМ. Только случай «строки себестоимости не несли ни ДО операции,
 * ни ПОСЛЕ» — тогда число в шапке физически не могло прийти из строк, значит оно
 * историческое. Если же себестоимость по строкам БЫЛА и обнулилась (убрали последнюю
 * платную строку) — это нормальный пересчёт, шапку обязаны обнулить.
 * Иначе себестоимость стала бы «липкой»: удалил единственный расход, а цифра осталась.
 * Тест «удаление платной строки обнуляет» ниже сторожит ровно это.
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
  workOrderLines,
  workOrders,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { deleteLine, getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { issueToWorkOrder } from '../modules/inventory-movements/repository';

let erfolgId = '';
let primaryClientId = '';

const TEST_PREFIX = 'TESTIMPCOST-';

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
    // Тикеты каскадом уносят наряды и их строки.
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    // Склад: movements → batches → items (FK RESTRICT, иначе падение).
    const items = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(like(inventoryItems.name, `${TEST_PREFIX}%`));
    if (items.length > 0) {
      const ids = items.map((r) => r.id);
      await tx.delete(inventoryMovements).where(inArray(inventoryMovements.itemId, ids));
      await tx.delete(inventoryBatches).where(inArray(inventoryBatches.itemId, ids));
      await tx.delete(inventoryItems).where(inArray(inventoryItems.id, ids));
    }
  });
}

async function freshOrder(): Promise<string> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}order`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  return wo.id;
}

/** Ставит себестоимость прямо в шапку — ровно так, как это делает импорт из WinServisePro
 *  (у строк себестоимости при этом нет). Через API такого пути нет, потому и SQL. */
async function setImportedHeaderCost(workOrderId: string, cost: bigint): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    const [wo] = await tx
      .select({ total: workOrders.totalAmountKopecks })
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId));
    await tx
      .update(workOrders)
      .set({
        costAmountKopecks: cost,
        marginAmountKopecks: (wo?.total ?? 0n) - cost,
      })
      .where(eq(workOrders.id, workOrderId));
  });
}

async function readTotals(workOrderId: string) {
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

async function firstLineId(workOrderId: string): Promise<string> {
  const [line] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ id: workOrderLines.id })
      .from(workOrderLines)
      .where(eq(workOrderLines.workOrderId, workOrderId)),
  );
  if (!line) throw new Error('нет строк наряда');
  return line.id;
}

/** Наряд «как импортированный»: строка без себестоимости + себестоимость в шапке. */
async function importedOrder(): Promise<string> {
  const workOrderId = await freshOrder();
  await upsertLine(getDb(), erfolgId, workOrderId, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}работа`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: 500_000n, // клиенту 5000 ₽
  });
  await setImportedHeaderCost(workOrderId, 300_000n); // себестоимость 3000 ₽ из старой базы
  return workOrderId;
}

describe('ДЕНЬГИ: себестоимость импортированного наряда переживает правку строк', () => {
  beforeEach(clearTestData);

  it('правка строки НЕ обнуляет себестоимость в шапке', async () => {
    const workOrderId = await importedOrder();
    const before = await readTotals(workOrderId);
    expect(before?.cost).toBe(300_000n);

    // Менеджер поправил цену в строке — самая обычная операция, автосейв по уходу курсора.
    await upsertLine(getDb(), erfolgId, workOrderId, await firstLineId(workOrderId), {
      lineType: 'work',
      name: `${TEST_PREFIX}работа`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 600_000n,
    });

    const after = await readTotals(workOrderId);
    expect(after?.total).toBe(600_000n);
    expect(after?.cost).toBe(300_000n); // ← до починки здесь был 0
    expect(after?.margin).toBe(300_000n); // маржа пересчитана от сохранённой себестоимости
  });

  it('добавление новой строки без себестоимости НЕ обнуляет шапку', async () => {
    const workOrderId = await importedOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'part',
      name: `${TEST_PREFIX}запчасть`,
      unit: 'шт',
      quantity: '2',
      unitPriceKopecks: 100_000n,
    });
    const after = await readTotals(workOrderId);
    expect(after?.total).toBe(700_000n);
    expect(after?.cost).toBe(300_000n);
    expect(after?.margin).toBe(400_000n);
  });

  it('удаление строки НЕ обнуляет шапку, если себестоимости по строкам не было', async () => {
    const workOrderId = await importedOrder();
    await deleteLine(getDb(), erfolgId, workOrderId, await firstLineId(workOrderId));
    const after = await readTotals(workOrderId);
    expect(after?.total).toBe(0n);
    expect(after?.cost).toBe(300_000n);
  });
});

describe('ДЕНЬГИ: выдача запчасти со склада — второй путь к той же шапке', () => {
  beforeEach(clearTestData);

  /** Заводит позицию склада с партией по заданной цене закупки. */
  async function stockItem(unitCostKopecks: bigint): Promise<string> {
    const [item] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .insert(inventoryItems)
        .values({ tenantId: erfolgId, name: `${TEST_PREFIX}запчасть`, unit: 'шт' })
        .returning({ id: inventoryItems.id }),
    );
    if (!item) throw new Error('не создалась позиция склада');
    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx.insert(inventoryBatches).values({
        tenantId: erfolgId,
        itemId: item.id,
        quantityInitial: '10',
        quantityRemaining: '10',
        unitCostKopecks,
        receivedAt: new Date('2026-01-01T00:00:00Z'),
      });
    });
    return item.id;
  }

  it('выдача запчасти с НУЛЕВОЙ закупочной ценой не обнуляет историческую себестоимость', async () => {
    // Второй писатель в cost_amount_kopecks — inventory-movements/repository.ts.
    // Партия по нулевой цене (в базе такие есть: цену закупки не всегда заполняют)
    // оставляет себестоимость строк нулевой, и шапка обнулилась бы тем же способом.
    const workOrderId = await importedOrder();
    const itemId = await stockItem(0n);
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'part',
      name: `${TEST_PREFIX}запчасть`,
      unit: 'шт',
      quantity: '2',
      unitPriceKopecks: 50_000n,
    });
    const lines = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ id: workOrderLines.id, type: workOrderLines.lineType })
        .from(workOrderLines)
        .where(eq(workOrderLines.workOrderId, workOrderId)),
    );
    const partLine = lines.find((l) => l.type === 'part');
    if (!partLine) throw new Error('нет строки запчасти');

    await issueToWorkOrder(getDb(), erfolgId, {
      workOrderLineId: partLine.id,
      itemId,
      quantity: '2',
      userId: null,
    });

    const after = await readTotals(workOrderId);
    expect(after?.cost).toBe(300_000n);
  });

  it('выдача запчасти с РЕАЛЬНОЙ ценой закупки считается по строкам, как и раньше', async () => {
    const workOrderId = await importedOrder();
    const itemId = await stockItem(1_000n); // 10 ₽ за штуку
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'part',
      name: `${TEST_PREFIX}запчасть`,
      unit: 'шт',
      quantity: '2',
      unitPriceKopecks: 50_000n,
    });
    const lines = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ id: workOrderLines.id, type: workOrderLines.lineType })
        .from(workOrderLines)
        .where(eq(workOrderLines.workOrderId, workOrderId)),
    );
    const partLine = lines.find((l) => l.type === 'part');
    if (!partLine) throw new Error('нет строки запчасти');

    await issueToWorkOrder(getDb(), erfolgId, {
      workOrderLineId: partLine.id,
      itemId,
      quantity: '2',
      userId: null,
    });

    // Себестоимость ПОЯВИЛАСЬ у строк — с этого момента считаем по строкам.
    const after = await readTotals(workOrderId);
    expect(after?.cost).toBe(2_000n);
  });
});

describe('обратная сторона: себестоимость по строкам НЕ становится «липкой»', () => {
  beforeEach(clearTestData);

  it('удаление единственной платной строки обнуляет себестоимость, как и раньше', async () => {
    const workOrderId = await freshOrder();
    // expense-строка: её себестоимость = цена, то есть по строкам себестоимость ЕСТЬ.
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'expense',
      name: `${TEST_PREFIX}расход`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 200_000n,
    });
    const before = await readTotals(workOrderId);
    expect(before?.cost).toBe(200_000n);

    await deleteLine(getDb(), erfolgId, workOrderId, await firstLineId(workOrderId));

    const after = await readTotals(workOrderId);
    // Себестоимость ПРИШЛА из строк — строку убрали, значит и её быть не должно.
    expect(after?.cost).toBe(0n);
    expect(after?.total).toBe(0n);
    expect(after?.margin).toBe(0n);
  });

  it('обнуление цены платной строки обнуляет себестоимость', async () => {
    const workOrderId = await freshOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'expense',
      name: `${TEST_PREFIX}расход`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 200_000n,
    });
    await upsertLine(getDb(), erfolgId, workOrderId, await firstLineId(workOrderId), {
      lineType: 'expense',
      name: `${TEST_PREFIX}расход`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 0n,
    });
    const after = await readTotals(workOrderId);
    expect(after?.cost).toBe(0n);
  });

  it('обычный наряд без импортной себестоимости считается по строкам как прежде', async () => {
    const workOrderId = await freshOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}работа`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 500_000n,
    });
    const after = await readTotals(workOrderId);
    expect(after?.cost).toBe(0n); // ставка инженера не задана → себестоимости нет
    expect(after?.margin).toBe(500_000n);
  });
});
