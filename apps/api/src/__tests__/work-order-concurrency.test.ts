/**
 * Concurrency-тесты:
 *   1. Параллельная FEFO-выдача (5 + 5 = 10, два запроса по 6 одновременно)
 *      должна закончиться: один OK + один NotEnoughStockError.
 *   2. Параллельное добавление платежей на один invoice — оба должны записаться
 *      и paid_amount должен быть = сумма обоих (защита через recomputeStatusFromPaid
 *      под FOR UPDATE).
 *
 * НАХОДКА: метода closeWorkOrder/setStatus в work-orders/repository нет —
 * наряд не имеет статуса (workflow управляется тикетом). Это ожидаемо для
 * текущей архитектуры, поэтому "двойное закрытие наряда" неприменимо. Вместо
 * этого тестируем эквивалентный реальный риск — двойную FEFO-выдачу.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import {
  clients,
  getDb,
  inventoryBatches,
  inventoryItems,
  inventoryMovements,
  invoices,
  payments,
  tickets,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { NotEnoughStockError, issueToWorkOrder } from '../modules/inventory-movements/repository';
import {
  createDraft as createInvoiceDraft,
  transitionToIssued,
} from '../modules/invoices/repository';
import { addPayment } from '../modules/payments/repository';

const TEST_PREFIX = 'TEST-CONC-';

let erfolgId = '';
let primaryClientId = '';

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
    await tx.execute(sql`
      DELETE FROM payments WHERE ticket_id IN (
        SELECT id FROM tickets WHERE symptom LIKE ${TEST_PREFIX + '%'}
      )
    `);
    await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    await tx.execute(sql`
      DELETE FROM inventory_movements WHERE item_id IN (
        SELECT id FROM inventory_items WHERE name LIKE ${TEST_PREFIX + '%'}
      )
    `);
    await tx.execute(sql`
      DELETE FROM inventory_batches WHERE item_id IN (
        SELECT id FROM inventory_items WHERE name LIKE ${TEST_PREFIX + '%'}
      )
    `);
    await tx.delete(inventoryItems).where(like(inventoryItems.name, `${TEST_PREFIX}%`));
  });
}

describe('concurrency: параллельная FEFO-выдача', () => {
  beforeEach(clearTestData);

  it('два параллельных issue по 6 на остатке 10 → один успех, один NotEnoughStock', async () => {
    // Setup: item + одна партия с qty=10
    const itemRows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .insert(inventoryItems)
        .values({ tenantId: erfolgId, name: `${TEST_PREFIX}race-item`, unit: 'шт' })
        .returning({ id: inventoryItems.id }),
    );
    const itemId = itemRows[0]!.id;
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.insert(inventoryBatches).values({
        tenantId: erfolgId,
        itemId,
        quantityInitial: '10',
        quantityRemaining: '10',
        unitCostKopecks: 100n,
        receivedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );

    // Два разных тикета + work_order + part-line каждый
    async function makeLine(tag: string): Promise<string> {
      const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
        clientId: primaryClientId,
        symptom: `${TEST_PREFIX}race-${tag}`,
      });
      const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
      const line = await upsertLine(getDb(), erfolgId, wo.id, null, {
        lineType: 'part',
        name: `${TEST_PREFIX}race-${tag}-line`,
        unit: 'шт',
        quantity: '6',
        unitPriceKopecks: 1_000n,
      });
      return line.id;
    }

    const [lineA, lineB] = await Promise.all([makeLine('A'), makeLine('B')]);

    // Параллельные issue по 6 (требуется 12, есть 10).
    // Защита: SELECT FOR UPDATE на batch внутри withTenantTx.
    const results = await Promise.allSettled([
      issueToWorkOrder(getDb(), erfolgId, {
        workOrderLineId: lineA,
        itemId,
        quantity: '6',
        userId: null,
      }),
      issueToWorkOrder(getDb(), erfolgId, {
        workOrderLineId: lineB,
        itemId,
        quantity: '6',
        userId: null,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // Ошибка должна быть NotEnoughStockError
    const err = (rejected[0] as PromiseRejectedResult).reason as unknown;
    expect(err).toBeInstanceOf(NotEnoughStockError);

    // Финальный остаток = 10 - 6 = 4
    const [b] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ q: inventoryBatches.quantityRemaining })
        .from(inventoryBatches)
        .where(eq(inventoryBatches.itemId, itemId)),
    );
    expect(Number(b!.q)).toBe(4);

    // Movements ровно 1 (от успешного issue).
    const movs = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ id: inventoryMovements.id })
        .from(inventoryMovements)
        .where(eq(inventoryMovements.itemId, itemId)),
    );
    expect(movs.length).toBe(1);
  });
});

describe('concurrency: параллельные платежи на один invoice', () => {
  beforeEach(clearTestData);

  it('два параллельных платежа на один invoice → оба успешны (retry-обёртка работает)', async () => {
    // Setup: ticket + work_order + invoice issued на 100000 коп.
    const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}pay-race`,
    });
    const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
    await upsertLine(getDb(), erfolgId, wo.id, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}pay-w`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 100_000n,
    });
    const draft = await createInvoiceDraft(getDb(), erfolgId, {
      workOrderId: wo.id,
      notes: `${TEST_PREFIX}pay-inv`,
    });
    await transitionToIssued(getDb(), erfolgId, draft.id, {});

    // Два параллельных платежа по 50000 коп (вместе = total).
    const results = await Promise.allSettled([
      addPayment(getDb(), erfolgId, {
        ticketId,
        invoiceId: draft.id,
        amountKopecks: 50_000n,
        method: 'cash',
        paidAt: new Date(),
        comment: `${TEST_PREFIX}p1`,
        userId: null,
      }),
      addPayment(getDb(), erfolgId, {
        ticketId,
        invoiceId: draft.id,
        amountKopecks: 50_000n,
        method: 'card',
        paidAt: new Date(),
        comment: `${TEST_PREFIX}p2`,
        userId: null,
      }),
    ]);

    // После Fix 3: withDbRetry автоматически повторяет транзакцию при 40001/40P01.
    // Оба платежа должны зафиксироваться.
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2);

    const allPays = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ id: payments.id, amount: payments.amountKopecks })
        .from(payments)
        .where(eq(payments.invoiceId, draft.id)),
    );
    expect(allPays.length).toBe(2);
    const sumActual = allPays.reduce((acc, p) => acc + p.amount, 0n);
    expect(sumActual).toBe(100_000n);

    const [inv] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ paid: invoices.paidAmountKopecks, status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, draft.id)),
    );
    expect(inv?.paid).toBe(100_000n);
    expect(inv?.status).toBe('paid');
  });

  it(
    'три параллельных платежа на один invoice → все три успешны, sum верный',
    { timeout: 30_000 },
    async () => {
      const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
        clientId: primaryClientId,
        symptom: `${TEST_PREFIX}pay-race-3`,
      });
      const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
      await upsertLine(getDb(), erfolgId, wo.id, null, {
        lineType: 'work',
        name: `${TEST_PREFIX}pay-w-3`,
        unit: 'шт',
        quantity: '1',
        unitPriceKopecks: 90_000n,
      });
      const draft = await createInvoiceDraft(getDb(), erfolgId, {
        workOrderId: wo.id,
        notes: `${TEST_PREFIX}pay-inv-3`,
      });
      await transitionToIssued(getDb(), erfolgId, draft.id, {});

      const amounts = [30_000n, 30_000n, 30_000n];
      const results = await Promise.allSettled(
        amounts.map((amt, i) =>
          addPayment(getDb(), erfolgId, {
            ticketId,
            invoiceId: draft.id,
            amountKopecks: amt,
            method: i === 0 ? 'cash' : i === 1 ? 'card' : 'bank_transfer',
            paidAt: new Date(),
            comment: `${TEST_PREFIX}p3-${i}`,
            userId: null,
          }),
        ),
      );

      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected.length).toBe(0);
      expect(ok.length).toBe(3);

      const [inv] = await withTenantTx(getDb(), erfolgId, (tx) =>
        tx
          .select({ paid: invoices.paidAmountKopecks, status: invoices.status })
          .from(invoices)
          .where(eq(invoices.id, draft.id)),
      );
      expect(inv?.paid).toBe(90_000n);
      expect(inv?.status).toBe('paid');
    },
  );
});

describe('FINDING: work_order не имеет status — повторный invoice идемпотентен', () => {
  beforeEach(clearTestData);

  it('createDraft на одном work_order дважды → возвращает тот же invoice (UNIQUE гарантия)', async () => {
    // Это позитивная проверка: если бы была race на createDraft, мы бы получили
    // два invoices. UNIQUE-индекс БД защищает + idempotent return существующего.
    const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}wo-idem`,
    });
    const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
    await upsertLine(getDb(), erfolgId, wo.id, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}wo-idem-line`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 50_000n,
    });

    const results = await Promise.allSettled([
      createInvoiceDraft(getDb(), erfolgId, {
        workOrderId: wo.id,
        notes: `${TEST_PREFIX}race-inv`,
      }),
      createInvoiceDraft(getDb(), erfolgId, {
        workOrderId: wo.id,
        notes: `${TEST_PREFIX}race-inv`,
      }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Финально должен быть ровно ОДИН живой invoice на этот work_order.
    const all = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.workOrderId, wo.id)),
    );
    expect(all.length).toBe(1);
  });
});
