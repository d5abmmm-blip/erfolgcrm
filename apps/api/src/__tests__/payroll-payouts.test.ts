/**
 * Выплаты ЗП (payroll_payouts) ↔ касса.
 *   • createPayout: создаёт расход в кассе и уменьшает остаток счёта; listPayouts находит;
 *   • updatePayout: ручная правка суммы корректирует остаток счёта;
 *   • deletePayout: возвращает остаток и убирает выплату;
 *   • аванс + окончательный расчёт сосуществуют за период; повтор одного типа запрещён;
 *   • премий за период — сколько угодно; премия идёт отдельной статьёй «Премии».
 *
 * Дельта-подход по остатку счёта; fileParallelism:false (см. cash-тесты).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  cashAccounts,
  cashCategories,
  cashTransactions,
  getDb,
  payrollPayouts,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createAccount, getAccountBalances } from '../modules/cash/repository';
import {
  createPayout,
  deletePayout,
  listPayouts,
  updatePayout,
  type CreatePayoutInput,
} from '../modules/payroll/repository';

let erfolgId = '';

const TEST_PREFIX = 'TESTPAYOUT-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(payrollPayouts).where(like(payrollPayouts.comment, `${TEST_PREFIX}%`));
    await tx.delete(cashTransactions).where(like(cashTransactions.comment, `${TEST_PREFIX}%`));
    await tx.delete(cashAccounts).where(like(cashAccounts.name, `${TEST_PREFIX}%`));
  });
}

async function balanceOf(accountId: string): Promise<bigint> {
  const rep = await getAccountBalances(getDb(), erfolgId);
  const acc = rep.accounts.find((a) => a.id === accountId);
  return BigInt(acc?.balanceKopecks ?? '0');
}

/** Имя статьи расхода в кассе, к которой привязан расход выплаты. */
async function categoryNameOfPayout(cashTransactionId: string | null): Promise<string | null> {
  if (!cashTransactionId) return null;
  return withTenantTx(getDb(), erfolgId, async (tx) => {
    const txn = await tx
      .select({ categoryId: cashTransactions.categoryId })
      .from(cashTransactions)
      .where(eq(cashTransactions.id, cashTransactionId))
      .limit(1);
    const categoryId = txn[0]?.categoryId;
    if (!categoryId) return null;
    const cat = await tx
      .select({ name: cashCategories.name })
      .from(cashCategories)
      .where(eq(cashCategories.id, categoryId))
      .limit(1);
    return cat[0]?.name ?? null;
  });
}

function makeInput(over: Partial<CreatePayoutInput> & { accountId: string }): CreatePayoutInput {
  return {
    engineerId: uuidv7(),
    kind: 'final',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-21',
    periodLabel: 'Месяц',
    computedKopecks: 42_000n,
    amountKopecks: 42_000n,
    paidOn: '2026-06-20',
    comment: `${TEST_PREFIX}июнь`,
    createdBy: null,
    ...over,
  };
}

async function makeAccount(): Promise<string> {
  const acc = await createAccount(getDb(), erfolgId, {
    name: `${TEST_PREFIX}нал`,
    kind: 'cash',
    openingBalanceKopecks: 100_000n,
  });
  return acc.id;
}

describe('payroll payouts ↔ касса', () => {
  beforeEach(clearTestData);

  it('createPayout создаёт расход в кассе и уменьшает остаток счёта', async () => {
    const accId = await makeAccount();
    const before = await balanceOf(accId);
    const payout = await createPayout(getDb(), erfolgId, makeInput({ accountId: accId }));

    expect(payout.cashTransactionId).toBeTruthy();
    expect(payout.kind).toBe('final');
    expect(payout.amountKopecks).toBe('42000');
    expect(before - (await balanceOf(accId))).toBe(42_000n);

    const list = await listPayouts(getDb(), erfolgId, '2026-06-01');
    expect(list.some((p) => p.id === payout.id)).toBe(true);
  });

  it('updatePayout (ручная правка суммы) корректирует остаток счёта', async () => {
    const accId = await makeAccount();
    const payout = await createPayout(getDb(), erfolgId, makeInput({ accountId: accId }));
    // было списано 42000 → остаток 58000. Поднимаем выплату до 50000 → остаток 50000.
    const updated = await updatePayout(getDb(), erfolgId, payout.id, { amountKopecks: 50_000n });
    expect(updated?.amountKopecks).toBe('50000');
    expect(await balanceOf(accId)).toBe(50_000n);
  });

  it('deletePayout возвращает остаток и убирает выплату', async () => {
    const accId = await makeAccount();
    const payout = await createPayout(
      getDb(),
      erfolgId,
      makeInput({ accountId: accId, computedKopecks: 30_000n, amountKopecks: 30_000n }),
    );
    expect(await balanceOf(accId)).toBe(70_000n);

    const ok = await deletePayout(getDb(), erfolgId, payout.id);
    expect(ok).toBe(true);
    expect(await balanceOf(accId)).toBe(100_000n);
    const list = await listPayouts(getDb(), erfolgId, '2026-06-01');
    expect(list.some((p) => p.id === payout.id)).toBe(false);
  });

  it('повторный расчёт (final) инженеру за тот же период запрещён', async () => {
    const accId = await makeAccount();
    const engineerId = uuidv7();
    const base = makeInput({ accountId: accId, engineerId, amountKopecks: 10_000n });
    await createPayout(getDb(), erfolgId, base);
    await expect(createPayout(getDb(), erfolgId, base)).rejects.toThrow();
  });

  it('аванс и окончательный расчёт сосуществуют за один период', async () => {
    const accId = await makeAccount();
    const engineerId = uuidv7();
    const advance = await createPayout(
      getDb(),
      erfolgId,
      makeInput({ accountId: accId, engineerId, kind: 'advance', amountKopecks: 20_000n }),
    );
    const final = await createPayout(
      getDb(),
      erfolgId,
      makeInput({ accountId: accId, engineerId, kind: 'final', amountKopecks: 22_000n }),
    );
    expect(advance.kind).toBe('advance');
    expect(final.kind).toBe('final');
    // Списаны оба: 20000 + 22000 = 42000 → остаток 58000.
    expect(await balanceOf(accId)).toBe(58_000n);
    const list = await listPayouts(getDb(), erfolgId, '2026-06-01');
    const mine = list.filter((p) => p.engineerId === engineerId);
    expect(mine.map((p) => p.kind).sort()).toEqual(['advance', 'final']);
  });

  it('повторный аванс за тот же период запрещён', async () => {
    const accId = await makeAccount();
    const engineerId = uuidv7();
    const adv = makeInput({ accountId: accId, engineerId, kind: 'advance', amountKopecks: 5_000n });
    await createPayout(getDb(), erfolgId, adv);
    await expect(createPayout(getDb(), erfolgId, adv)).rejects.toThrow();
  });

  it('премий за период может быть несколько и они идут отдельной статьёй «Премии»', async () => {
    const accId = await makeAccount();
    const engineerId = uuidv7();
    const b1 = await createPayout(
      getDb(),
      erfolgId,
      makeInput({
        accountId: accId,
        engineerId,
        kind: 'bonus',
        computedKopecks: 0n,
        amountKopecks: 3_000n,
        comment: `${TEST_PREFIX}премия1`,
      }),
    );
    const b2 = await createPayout(
      getDb(),
      erfolgId,
      makeInput({
        accountId: accId,
        engineerId,
        kind: 'bonus',
        computedKopecks: 0n,
        amountKopecks: 2_000n,
        comment: `${TEST_PREFIX}премия2`,
      }),
    );
    expect(b1.kind).toBe('bonus');
    expect(b2.kind).toBe('bonus');
    // Обе премии списаны: 3000 + 2000 = 5000 → остаток 95000.
    expect(await balanceOf(accId)).toBe(95_000n);
    // Отдельная статья «Премии» (не «Зарплата»).
    expect(await categoryNameOfPayout(b1.cashTransactionId)).toBe('Премии');
    expect(await categoryNameOfPayout(b2.cashTransactionId)).toBe('Премии');
  });

  it('аванс/расчёт идут статьёй «Зарплата»', async () => {
    const accId = await makeAccount();
    const payout = await createPayout(
      getDb(),
      erfolgId,
      makeInput({ accountId: accId, kind: 'advance', amountKopecks: 7_000n }),
    );
    expect(await categoryNameOfPayout(payout.cashTransactionId)).toBe('Зарплата');
  });
});
