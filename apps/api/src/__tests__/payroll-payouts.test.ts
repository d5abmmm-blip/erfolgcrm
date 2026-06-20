/**
 * Выплаты ЗП (payroll_payouts) ↔ касса.
 *   • createPayout: создаёт расход в кассе и уменьшает остаток счёта; listPayouts находит;
 *   • updatePayout: ручная правка суммы корректирует остаток счёта;
 *   • deletePayout: возвращает остаток и убирает выплату;
 *   • повторная выплата за тот же период инженеру запрещена.
 *
 * Дельта-подход по остатку счёта; fileParallelism:false (см. cash-тесты).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { cashAccounts, cashTransactions, getDb, payrollPayouts, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createAccount, getAccountBalances } from '../modules/cash/repository';
import { createPayout, deletePayout, listPayouts, updatePayout } from '../modules/payroll/repository';

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

describe('payroll payouts ↔ касса', () => {
  beforeEach(clearTestData);

  it('createPayout создаёт расход в кассе и уменьшает остаток счёта', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 100_000n,
    });
    const before = await balanceOf(acc.id);

    const engineerId = uuidv7();
    const payout = await createPayout(getDb(), erfolgId, {
      engineerId,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-21',
      periodLabel: 'Месяц',
      computedKopecks: 42_000n,
      amountKopecks: 42_000n,
      paidOn: '2026-06-20',
      accountId: acc.id,
      comment: `${TEST_PREFIX}июнь`,
      createdBy: null,
    });

    expect(payout.cashTransactionId).toBeTruthy();
    expect(payout.amountKopecks).toBe('42000');
    expect(before - (await balanceOf(acc.id))).toBe(42_000n);

    const list = await listPayouts(getDb(), erfolgId, '2026-06-01');
    expect(list.some((p) => p.id === payout.id)).toBe(true);
  });

  it('updatePayout (ручная правка суммы) корректирует остаток счёта', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 100_000n,
    });
    const engineerId = uuidv7();
    const payout = await createPayout(getDb(), erfolgId, {
      engineerId,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-21',
      periodLabel: 'Месяц',
      computedKopecks: 42_000n,
      amountKopecks: 42_000n,
      paidOn: '2026-06-20',
      accountId: acc.id,
      comment: `${TEST_PREFIX}июнь`,
      createdBy: null,
    });
    // было списано 42000 → остаток 58000. Поднимаем выплату до 50000 → остаток 50000.
    const updated = await updatePayout(getDb(), erfolgId, payout.id, { amountKopecks: 50_000n });
    expect(updated?.amountKopecks).toBe('50000');
    expect(await balanceOf(acc.id)).toBe(50_000n);
  });

  it('deletePayout возвращает остаток и убирает выплату', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 100_000n,
    });
    const engineerId = uuidv7();
    const payout = await createPayout(getDb(), erfolgId, {
      engineerId,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-21',
      periodLabel: 'Месяц',
      computedKopecks: 30_000n,
      amountKopecks: 30_000n,
      paidOn: '2026-06-20',
      accountId: acc.id,
      comment: `${TEST_PREFIX}июнь`,
      createdBy: null,
    });
    expect(await balanceOf(acc.id)).toBe(70_000n);

    const ok = await deletePayout(getDb(), erfolgId, payout.id);
    expect(ok).toBe(true);
    expect(await balanceOf(acc.id)).toBe(100_000n);
    const list = await listPayouts(getDb(), erfolgId, '2026-06-01');
    expect(list.some((p) => p.id === payout.id)).toBe(false);
  });

  it('повторная выплата инженеру за тот же период запрещена', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 100_000n,
    });
    const engineerId = uuidv7();
    const base = {
      engineerId,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-21',
      periodLabel: 'Месяц',
      computedKopecks: 10_000n,
      amountKopecks: 10_000n,
      paidOn: '2026-06-20',
      accountId: acc.id,
      comment: `${TEST_PREFIX}июнь`,
      createdBy: null,
    };
    await createPayout(getDb(), erfolgId, base);
    await expect(createPayout(getDb(), erfolgId, base)).rejects.toThrow();
  });
});
