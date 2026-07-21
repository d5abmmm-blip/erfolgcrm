/**
 * Копейки в платежах.
 *
 * ЗАЧЕМ. Счёт на 1 498,50 ₽ закрыть было НЕВОЗМОЖНО: платёж принимался только
 * целыми рублями. 1498 ₽ оставляли счёт вечно недоплаченным (он висит в дебиторке,
 * и робот шлёт клиенту напоминания об уже оплаченном счёте), а 1499 ₽ упирались
 * в ограничение базы `invoices_paid_not_exceeds_total` и выдавали человеку сырую
 * ошибку PostgreSQL.
 *
 * Копейки берутся из обычной работы, а не из экзотики: дробное количество в наряде
 * (поле принимает 0,5) и НДС 5% «в том числе».
 *
 * Проверяем через appRouter.createCaller, а НЕ через addPayment напрямую:
 * ограничение стояло в zod-схеме роутера, репозиторий копейки принимал всегда.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, invoices, payments, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { createDraft, getById, transitionToIssued } from '../modules/invoices/repository';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let staffUserId = '';
let clientId = '';

const TEST_PREFIX = 'TESTKOP-';
/** 1 498,50 ₽ — тот самый счёт, который нельзя было закрыть. */
const INVOICE_KOPECKS = 149_850n;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [u] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.tenantId, erfolgId)).limit(1),
  );
  staffUserId = u?.id ?? '';
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  clientId = c?.id ?? '';
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(payments).where(like(payments.comment, `${TEST_PREFIX}%`));
    await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(): Context {
  const session: SessionData = {
    tenantId: erfolgId,
    userId: staffUserId,
    username: 'kopecks-test',
    role: 'director',
    fullName: 'Test Director',
    expiresAt: Date.now() + 3_600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: erfolgId,
      subdomain: 'erfolg',
      displayName: 'erfolg',
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    },
    session,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
  };
}

/** Выставленный счёт ровно на amountKopecks. */
async function setupInvoice(
  amountKopecks: bigint,
): Promise<{ ticketId: string; invoiceId: string }> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
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
    notes: `${TEST_PREFIX}inv`,
  });
  const issued = await transitionToIssued(getDb(), erfolgId, draft.id, {});
  if (!issued) throw new Error('issue failed');
  return { ticketId, invoiceId: issued.id };
}

describe('копейки в платежах', () => {
  beforeEach(clearTestData);

  it('счёт на 1 498,50 ₽ можно закрыть ровно этой суммой', async () => {
    const { ticketId, invoiceId } = await setupInvoice(INVOICE_KOPECKS);
    const caller = appRouter.createCaller(makeCtx());

    await caller.payments.add({
      ticketId,
      invoiceId,
      amountRub: 1498.5,
      method: 'cash',
      comment: `${TEST_PREFIX}точная оплата`,
    });

    const inv = await getById(getDb(), erfolgId, invoiceId);
    // Ключевое: счёт ЗАКРЫТ, а не «частично оплачен» навсегда.
    expect(inv?.status).toBe('paid');
    expect(inv?.paidAmountKopecks).toBe(INVOICE_KOPECKS.toString());
  });

  it('копейки не теряются при переводе в базу', async () => {
    const { ticketId, invoiceId } = await setupInvoice(INVOICE_KOPECKS);
    const caller = appRouter.createCaller(makeCtx());

    // 0,05 ₽ = 5 копеек. Целочисленное усечение дало бы 0.
    await caller.payments.add({
      ticketId,
      invoiceId,
      amountRub: 0.05,
      method: 'cash',
      comment: `${TEST_PREFIX}пять копеек`,
    });

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ amount: payments.amountKopecks })
        .from(payments)
        .where(like(payments.comment, `${TEST_PREFIX}пять копеек`)),
    );
    expect(row?.amount).toBe(5n);
  });

  it('сумма точнее копейки отклоняется понятным текстом, а не сырой ошибкой базы', async () => {
    const { ticketId, invoiceId } = await setupInvoice(INVOICE_KOPECKS);
    const caller = appRouter.createCaller(makeCtx());

    // Без этой проверки 1498.567 молча округлилось бы до 1498.57 — а при сумме
    // чуть больше счёта округление ВВЕРХ упёрлось бы в ограничение базы
    // invoices_paid_not_exceeds_total и вернуло человеку SQL-текст.
    await expect(
      caller.payments.add({
        ticketId,
        invoiceId,
        amountRub: 1498.567,
        method: 'cash',
        comment: `${TEST_PREFIX}слишком точно`,
      }),
    ).rejects.toThrow(/копейк/i);
  });

  it('ноль и отрицательная сумма по-прежнему не принимаются', async () => {
    const { ticketId, invoiceId } = await setupInvoice(INVOICE_KOPECKS);
    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.payments.add({
        ticketId,
        invoiceId,
        amountRub: 0,
        method: 'cash',
        comment: `${TEST_PREFIX}ноль`,
      }),
    ).rejects.toThrow();

    await expect(
      caller.payments.add({
        ticketId,
        invoiceId,
        amountRub: -5,
        method: 'cash',
        comment: `${TEST_PREFIX}минус`,
      }),
    ).rejects.toThrow();
  });

  it('целые рубли продолжают работать как раньше', async () => {
    const { ticketId, invoiceId } = await setupInvoice(100_000n);
    const caller = appRouter.createCaller(makeCtx());

    await caller.payments.add({
      ticketId,
      invoiceId,
      amountRub: 1000,
      method: 'cash',
      comment: `${TEST_PREFIX}целые`,
    });

    const inv = await getById(getDb(), erfolgId, invoiceId);
    expect(inv?.status).toBe('paid');
    expect(inv?.paidAmountKopecks).toBe('100000');
  });
});
