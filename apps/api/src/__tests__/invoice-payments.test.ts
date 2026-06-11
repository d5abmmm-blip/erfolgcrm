/**
 * Этап 8.B — payments → invoice материализация:
 *   • paid_amount_kopecks пересчитывается под FOR UPDATE.
 *   • status автоматически переходит issued → partially_paid → paid → partially_paid (на удалении).
 *   • Платёж на чужой/cancelled/draft invoice — fail.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import {
  clients,
  getDb,
  invoices,
  payments,
  tickets,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import {
  getOrCreateWorkOrder,
  upsertLine,
} from '../modules/work-orders/repository';
import {
  createDraft,
  getById,
  transitionToCancelled,
  transitionToIssued,
} from '../modules/invoices/repository';
import { addPayment, deletePayment } from '../modules/payments/repository';

let erfolgId = '';
let demoId = '';
let primaryClientId = '';

const TEST_PREFIX = 'TEST8B-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(payments).where(like(payments.comment, `${TEST_PREFIX}%`));
      await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    });
  }
}

async function setupIssuedInvoice(amountKopecks = 100_000n): Promise<{
  ticketId: string;
  workOrderId: string;
  invoiceId: string;
}> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}work`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: amountKopecks,
  });
  const draft = await createDraft(getDb(), erfolgId, {
    workOrderId: wo.id,
    notes: `${TEST_PREFIX}invoice`,
  });
  const issued = await transitionToIssued(getDb(), erfolgId, draft.id, {});
  if (!issued) throw new Error('setup: issue failed');
  return { ticketId, workOrderId: wo.id, invoiceId: issued.id };
}

describe('invoice payments materialization (8.B)', () => {
  beforeEach(clearTestData);

  it('partial payment → status partially_paid, paid_amount=30000', async () => {
    const { ticketId, invoiceId } = await setupIssuedInvoice();
    const result = await addPayment(getDb(), erfolgId, {
      ticketId,
      invoiceId,
      amountKopecks: 30_000n,
      method: 'cash',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}part1`,
      userId: null,
    });
    expect(result.invoicePaidKopecks).toBe('30000');
    const inv = await getById(getDb(), erfolgId, invoiceId);
    expect(inv?.status).toBe('partially_paid');
    expect(inv?.paidAmountKopecks).toBe('30000');
  });

  it('full payment → status paid, paidAt заполнен', async () => {
    const { ticketId, invoiceId } = await setupIssuedInvoice();
    await addPayment(getDb(), erfolgId, {
      ticketId,
      invoiceId,
      amountKopecks: 100_000n,
      method: 'card',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}full`,
      userId: null,
    });
    const inv = await getById(getDb(), erfolgId, invoiceId);
    expect(inv?.status).toBe('paid');
    expect(inv?.paidAmountKopecks).toBe('100000');
    expect(inv?.paidAt).toBeInstanceOf(Date);
  });

  it('два платежа суммируются: 30000 + 70000 = paid', async () => {
    const { ticketId, invoiceId } = await setupIssuedInvoice();
    await addPayment(getDb(), erfolgId, {
      ticketId,
      invoiceId,
      amountKopecks: 30_000n,
      method: 'cash',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}sum1`,
      userId: null,
    });
    await addPayment(getDb(), erfolgId, {
      ticketId,
      invoiceId,
      amountKopecks: 70_000n,
      method: 'card',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}sum2`,
      userId: null,
    });
    const inv = await getById(getDb(), erfolgId, invoiceId);
    expect(inv?.status).toBe('paid');
    expect(inv?.paidAmountKopecks).toBe('100000');
  });

  it('удаление платежа откатывает статус: paid → partially_paid', async () => {
    const { ticketId, invoiceId } = await setupIssuedInvoice();
    const first = await addPayment(getDb(), erfolgId, {
      ticketId,
      invoiceId,
      amountKopecks: 30_000n,
      method: 'cash',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}d1`,
      userId: null,
    });
    await addPayment(getDb(), erfolgId, {
      ticketId,
      invoiceId,
      amountKopecks: 70_000n,
      method: 'card',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}d2`,
      userId: null,
    });
    const before = await getById(getDb(), erfolgId, invoiceId);
    expect(before?.status).toBe('paid');
    await deletePayment(getDb(), erfolgId, first.id);
    const after = await getById(getDb(), erfolgId, invoiceId);
    expect(after?.status).toBe('partially_paid');
    expect(after?.paidAmountKopecks).toBe('70000');
    expect(after?.paidAt).toBeNull();
  });

  it('удаление всех платежей → status issued, paid=0', async () => {
    const { ticketId, invoiceId } = await setupIssuedInvoice();
    const p = await addPayment(getDb(), erfolgId, {
      ticketId,
      invoiceId,
      amountKopecks: 50_000n,
      method: 'cash',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}all`,
      userId: null,
    });
    await deletePayment(getDb(), erfolgId, p.id);
    const inv = await getById(getDb(), erfolgId, invoiceId);
    expect(inv?.status).toBe('issued');
    expect(inv?.paidAmountKopecks).toBe('0');
  });

  it('платёж в draft счёт — fail', async () => {
    const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}draftpay`,
    });
    const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
    await upsertLine(getDb(), erfolgId, wo.id, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}w`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 50_000n,
    });
    const draft = await createDraft(getDb(), erfolgId, {
      workOrderId: wo.id,
      notes: `${TEST_PREFIX}draftinv`,
    });
    await expect(
      addPayment(getDb(), erfolgId, {
        ticketId,
        invoiceId: draft.id,
        amountKopecks: 10_000n,
        method: 'cash',
        paidAt: new Date(),
        comment: `${TEST_PREFIX}badpay`,
        userId: null,
      }),
    ).rejects.toThrow(/черновик|draft/i);
  });

  it('платёж в cancelled счёт — fail', async () => {
    const { ticketId, invoiceId } = await setupIssuedInvoice();
    await transitionToCancelled(getDb(), erfolgId, invoiceId, 'тест');
    await expect(
      addPayment(getDb(), erfolgId, {
        ticketId,
        invoiceId,
        amountKopecks: 10_000n,
        method: 'cash',
        paidAt: new Date(),
        comment: `${TEST_PREFIX}cancelledpay`,
        userId: null,
      }),
    ).rejects.toThrow(/отмен|cancelled/i);
  });

  it('платёж с invoice_id, не совпадающим с ticket_id — fail', async () => {
    const a = await setupIssuedInvoice();
    // Второй тикет с другим invoice
    const b = await setupIssuedInvoice();
    await expect(
      addPayment(getDb(), erfolgId, {
        ticketId: a.ticketId,
        invoiceId: b.invoiceId, // mismatch
        amountKopecks: 1_000n,
        method: 'cash',
        paidAt: new Date(),
        comment: `${TEST_PREFIX}mix`,
        userId: null,
      }),
    ).rejects.toThrow(/не принадлежит|not.*belong/i);
  });

  it('payment без invoiceId по-прежнему работает (старый поток)', async () => {
    const { ticketId } = await setupIssuedInvoice();
    const result = await addPayment(getDb(), erfolgId, {
      ticketId,
      // invoiceId не передан
      amountKopecks: 25_000n,
      method: 'cash',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}freepay`,
      userId: null,
    });
    expect(result.invoicePaidKopecks).toBeNull();
    expect(result.paidTotalKopecks).toBe('25000');
  });
});
