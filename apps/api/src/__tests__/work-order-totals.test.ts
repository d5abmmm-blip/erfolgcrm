/**
 * Тесты на бизнес-инвариант: work_orders.{works,parts,expenses,total}_amount_kopecks
 * материализованы — пересчитываются при каждом upsert/delete строки.
 *
 * Также покрывается каскад: delete ticket → work_order и lines удаляются.
 *
 * Используем repository-функции напрямую. amounts проверяем как BigInt
 * (Drizzle с mode:'bigint' возвращает bigint).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  tickets,
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
  workOrderIdForTicket,
} from '../modules/work-orders/repository';

let erfolgId = '';
let primaryClientId = '';

const TEST_PREFIX = 'TEST-WO-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, async (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
});

async function clearTestTickets(): Promise<void> {
  // CASCADE: delete tickets → удалит наряды и строки.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}

async function createTicketWithEmptyOrder(): Promise<{
  ticketId: string;
  workOrderId: string;
}> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}base`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  return { ticketId, workOrderId: wo.id };
}

async function selectWorkOrderRow(id: string) {
  const [row] = await withTenantTx(getDb(), erfolgId, async (tx) =>
    tx.select().from(workOrders).where(eq(workOrders.id, id)).limit(1),
  );
  return row;
}

describe('work_orders totals: материализация', () => {
  beforeEach(async () => {
    await clearTestTickets();
  });

  it('ensureWorkOrder создаёт пустой наряд с totals=0', async () => {
    const { workOrderId } = await createTicketWithEmptyOrder();
    const row = await selectWorkOrderRow(workOrderId);
    expect(row?.worksAmountKopecks).toBe(0n);
    expect(row?.partsAmountKopecks).toBe(0n);
    expect(row?.expensesAmountKopecks).toBe(0n);
    expect(row?.totalAmountKopecks).toBe(0n);
  });

  it('upsertLine work qty=2 unitPrice=350000 → works=700000, total=700000', async () => {
    const { workOrderId } = await createTicketWithEmptyOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Диагностика',
      unit: 'шт',
      quantity: '2',
      unitPriceKopecks: 350_000n,
    });
    const row = await selectWorkOrderRow(workOrderId);
    expect(row?.worksAmountKopecks).toBe(700_000n);
    expect(row?.totalAmountKopecks).toBe(700_000n);
  });

  it('upsertLine part qty=1 unitPrice=2850000 → parts добавляются к total', async () => {
    const { workOrderId } = await createTicketWithEmptyOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Работа',
      unit: 'шт',
      quantity: '2',
      unitPriceKopecks: 350_000n,
    });
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'part',
      name: 'Запчасть',
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 2_850_000n,
    });
    const row = await selectWorkOrderRow(workOrderId);
    expect(row?.partsAmountKopecks).toBe(2_850_000n);
    expect(row?.totalAmountKopecks).toBe(3_550_000n);
  });

  it('update строки: qty 2 → 3 пересчитывает worksAmountKopecks', async () => {
    const { workOrderId } = await createTicketWithEmptyOrder();
    const { id: lineId } = await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Работа',
      unit: 'шт',
      quantity: '2',
      unitPriceKopecks: 350_000n,
    });
    await upsertLine(getDb(), erfolgId, workOrderId, lineId, {
      lineType: 'work',
      name: 'Работа',
      unit: 'шт',
      quantity: '3',
      unitPriceKopecks: 350_000n,
    });
    const row = await selectWorkOrderRow(workOrderId);
    expect(row?.worksAmountKopecks).toBe(1_050_000n);
    expect(row?.totalAmountKopecks).toBe(1_050_000n);
  });

  it('delete строки → пересчёт totals', async () => {
    const { workOrderId } = await createTicketWithEmptyOrder();
    const { id: lineId } = await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Работа',
      unit: 'шт',
      quantity: '2',
      unitPriceKopecks: 350_000n,
    });
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'part',
      name: 'Запчасть',
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 2_850_000n,
    });
    await deleteLine(getDb(), erfolgId, workOrderId, lineId);
    const row = await selectWorkOrderRow(workOrderId);
    expect(row?.worksAmountKopecks).toBe(0n);
    expect(row?.partsAmountKopecks).toBe(2_850_000n);
    expect(row?.totalAmountKopecks).toBe(2_850_000n);
  });

  it('CASCADE: delete ticket → work_order и lines удаляются', async () => {
    const { ticketId, workOrderId } = await createTicketWithEmptyOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Работа',
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 100_000n,
    });
    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx.delete(tickets).where(eq(tickets.id, ticketId));
    });
    const woId = await workOrderIdForTicket(getDb(), erfolgId, ticketId);
    expect(woId).toBeNull();
    const lines = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(workOrderLines).where(eq(workOrderLines.workOrderId, workOrderId)),
    );
    expect(lines.length).toBe(0);
  });
});
