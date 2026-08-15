/**
 * Тесты для payments: материализация work_orders.paid_amount_kopecks.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { clients, getDb, payments, tickets, withTenantTx, workOrders } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { addPayment, deletePayment } from '../modules/payments/repository';

let erfolgId = '';
let primaryClientId = '';

const TEST_PREFIX = 'TEST-PAY-';

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
    // Сначала платежи, потом заявки: с миграции 0085 FK payments.ticket_id —
    // RESTRICT, заявка с платежами физически не удаляется.
    const ids = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(like(tickets.symptom, `${TEST_PREFIX}%`));
    if (ids.length > 0) {
      await tx.delete(payments).where(
        inArray(
          payments.ticketId,
          ids.map((t) => t.id),
        ),
      );
    }
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}

async function createTicketWithOrder(): Promise<{
  ticketId: string;
  workOrderId: string;
}> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}base`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  // Накидываем 1000₽ работы для сравнения с paid_amount.
  await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}work`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: 100_000n, // 1000₽
  });
  return { ticketId, workOrderId: wo.id };
}

async function selectWorkOrder(id: string) {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({
        paid: workOrders.paidAmountKopecks,
        total: workOrders.totalAmountKopecks,
      })
      .from(workOrders)
      .where(eq(workOrders.id, id)),
  );
  return row;
}

describe('payments totals: материализация paid_amount_kopecks', () => {
  beforeEach(async () => {
    await clearTestData();
  });

  it('initial paid=0', async () => {
    const { workOrderId } = await createTicketWithOrder();
    const wo = await selectWorkOrder(workOrderId);
    expect(wo?.paid).toBe(0n);
    expect(wo?.total).toBe(100_000n);
  });

  it('addPayment 30000 → paid=30000', async () => {
    const { ticketId, workOrderId } = await createTicketWithOrder();
    const result = await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 30_000n,
      method: 'cash',
      paidAt: new Date(),
      userId: null,
    });
    expect(result.paidTotalKopecks).toBe('30000');

    const wo = await selectWorkOrder(workOrderId);
    expect(wo?.paid).toBe(30_000n);
  });

  it('addPayment суммирует: 30000 + 50000 = 80000', async () => {
    const { ticketId, workOrderId } = await createTicketWithOrder();
    await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 30_000n,
      method: 'cash',
      paidAt: new Date(),
      userId: null,
    });
    await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 50_000n,
      method: 'card',
      paidAt: new Date(),
      userId: null,
    });
    const wo = await selectWorkOrder(workOrderId);
    expect(wo?.paid).toBe(80_000n);
  });

  it('deletePayment вычитает: 80000 - 30000 = 50000', async () => {
    const { ticketId, workOrderId } = await createTicketWithOrder();
    const first = await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 30_000n,
      method: 'cash',
      paidAt: new Date(),
      userId: null,
    });
    await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 50_000n,
      method: 'card',
      paidAt: new Date(),
      userId: null,
    });

    const afterDelete = await deletePayment(getDb(), erfolgId, first.id);
    expect(afterDelete?.paidTotalKopecks).toBe('50000');

    const wo = await selectWorkOrder(workOrderId);
    expect(wo?.paid).toBe(50_000n);
  });

  it('заявку с платежами удалить нельзя (RESTRICT с 0085) — платёж выживает', async () => {
    // До 0085 здесь был CASCADE: удаление заявки молча уносило платежи.
    const { ticketId } = await createTicketWithOrder();
    await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 50_000n,
      method: 'cash',
      paidAt: new Date(),
      userId: null,
    });
    const rejection = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.delete(tickets).where(eq(tickets.id, ticketId)),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(rejection).toBeTruthy();
    const survivors = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(payments).where(eq(payments.ticketId, ticketId)),
    );
    expect(survivors.length).toBe(1);
  });
});
