/**
 * Этап B — оплаты по заявкам → касса.
 *   • addPayment создаёт доход в кассе на счёт по методу (cash→Наличные, card→Карта,
 *     bank_transfer→Расчётный счёт), остаток счёта растёт;
 *   • повторный sync того же платежа не задваивает доход (UNIQUE + ON CONFLICT);
 *   • deletePayment убирает доход и откатывает остаток.
 *
 * Опирается на seed-счета (Наличные/Расчётный счёт/Карта с default_for_method).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { cashTransactions, clients, getDb, payments, tickets, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { addPayment, deletePayment } from '../modules/payments/repository';
import { listAccounts } from '../modules/cash/repository';
import { syncCashFromPaymentInTx } from '../modules/payments/cash-sync';

let erfolgId = '';
let primaryClientId = '';

const TEST_PREFIX = 'TESTCASHSYNC-';

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
    await tx.execute(
      sql`DELETE FROM cash_transactions WHERE ticket_id IN (SELECT id FROM tickets WHERE symptom LIKE ${`${TEST_PREFIX}%`})`,
    );
    await tx.delete(payments).where(like(payments.comment, `${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    // Прямое удаление cash-операций не пересчитывает материализованный остаток —
    // делаем это вручную, иначе baseline баланса дрейфует между тестами.
    await tx.execute(sql`
      UPDATE cash_accounts a
         SET balance_kopecks = a.opening_balance_kopecks + COALESCE((
               SELECT SUM(CASE
                        WHEN ct.kind='income'   AND ct.account_id=a.id THEN ct.amount_kopecks
                        WHEN ct.kind='expense'  AND ct.account_id=a.id THEN -ct.amount_kopecks
                        WHEN ct.kind='transfer' AND ct.account_id=a.id THEN -ct.amount_kopecks
                        WHEN ct.kind='transfer' AND ct.counter_account_id=a.id THEN ct.amount_kopecks
                        ELSE 0 END)
                 FROM cash_transactions ct
                WHERE ct.deleted_at IS NULL AND (ct.account_id=a.id OR ct.counter_account_id=a.id)
             ), 0)
       WHERE a.deleted_at IS NULL
    `);
  });
}

async function newTicket(): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}sync`,
  });
  return id;
}

async function accountByMethod(method: 'cash' | 'card' | 'bank_transfer'): Promise<string> {
  const accounts = await listAccounts(getDb(), erfolgId, { includeArchived: true });
  const acc = accounts.find((a) => a.defaultForMethod === method);
  if (!acc) throw new Error(`no default account for ${method}`);
  return acc.id;
}

async function balanceOf(accountId: string): Promise<bigint> {
  const accounts = await listAccounts(getDb(), erfolgId, { includeArchived: true });
  return BigInt(accounts.find((a) => a.id === accountId)?.balanceKopecks ?? '0');
}

async function cashTxForPayment(paymentId: string) {
  return withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ id: cashTransactions.id, amountKopecks: cashTransactions.amountKopecks, accountId: cashTransactions.accountId })
      .from(cashTransactions)
      .where(and(eq(cashTransactions.paymentId, paymentId), isNull(cashTransactions.deletedAt))),
  );
}

describe('payments → cash sync (этап B)', () => {
  beforeEach(clearTestData);

  it('addPayment cash → доход на счёт «Наличные», остаток растёт', async () => {
    const ticketId = await newTicket();
    const accId = await accountByMethod('cash');
    const before = await balanceOf(accId);

    const res = await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 150_000n,
      method: 'cash',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}cash`,
      userId: null,
    });

    const txs = await cashTxForPayment(res.id);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.amountKopecks).toBe(150_000n);
    expect(txs[0]?.accountId).toBe(accId);
    expect(await balanceOf(accId)).toBe(before + 150_000n);
  });

  it('маппинг метода: card → «Карта», bank_transfer → «Расчётный счёт»', async () => {
    const cardAcc = await accountByMethod('card');
    const bankAcc = await accountByMethod('bank_transfer');

    const t1 = await newTicket();
    const p1 = await addPayment(getDb(), erfolgId, {
      ticketId: t1, amountKopecks: 10_000n, method: 'card', paidAt: new Date(),
      comment: `${TEST_PREFIX}card`, userId: null,
    });
    expect((await cashTxForPayment(p1.id))[0]?.accountId).toBe(cardAcc);

    const t2 = await newTicket();
    const p2 = await addPayment(getDb(), erfolgId, {
      ticketId: t2, amountKopecks: 20_000n, method: 'bank_transfer', paidAt: new Date(),
      comment: `${TEST_PREFIX}bank`, userId: null,
    });
    expect((await cashTxForPayment(p2.id))[0]?.accountId).toBe(bankAcc);
  });

  it('повторный sync платежа не задваивает доход (идемпотентность)', async () => {
    const ticketId = await newTicket();
    const res = await addPayment(getDb(), erfolgId, {
      ticketId, amountKopecks: 50_000n, method: 'cash', paidAt: new Date(),
      comment: `${TEST_PREFIX}idem`, userId: null,
    });
    // имитируем повторный вызов синхронизации (как при ретрае транзакции)
    await withTenantTx(getDb(), erfolgId, (tx) =>
      syncCashFromPaymentInTx(tx, erfolgId, {
        id: res.id, ticketId, invoiceId: null, amountKopecks: 50_000n,
        method: 'cash', paidAt: new Date(), userId: null,
      }),
    );
    expect(await cashTxForPayment(res.id)).toHaveLength(1);
  });

  it('deletePayment убирает доход и откатывает остаток', async () => {
    const ticketId = await newTicket();
    const accId = await accountByMethod('cash');
    const before = await balanceOf(accId);
    const res = await addPayment(getDb(), erfolgId, {
      ticketId, amountKopecks: 80_000n, method: 'cash', paidAt: new Date(),
      comment: `${TEST_PREFIX}del`, userId: null,
    });
    expect(await balanceOf(accId)).toBe(before + 80_000n);

    await deletePayment(getDb(), erfolgId, res.id);
    expect(await cashTxForPayment(res.id)).toHaveLength(0);
    expect(await balanceOf(accId)).toBe(before);
  });
});
