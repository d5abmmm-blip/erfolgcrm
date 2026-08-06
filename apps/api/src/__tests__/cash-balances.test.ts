/**
 * Касса (этап A) — материализация остатков счетов.
 *   • opening → balance; income +; expense −; transfer (−откуда / +куда);
 *   • удаление операции откатывает остаток; изменение opening пересчитывает;
 *   • валидация: перевод на тот же счёт, чужая статья, несуществующий счёт.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { cashAccounts, cashCategories, cashTransactions, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createAccount,
  createCategory,
  createTransaction,
  deleteAccount,
  deleteTransaction,
  listAccounts,
  updateAccount,
} from '../modules/cash/repository';

let erfolgId = '';
let demoId = '';

const TEST_PREFIX = 'TESTCASHBAL-';
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(cashTransactions).where(like(cashTransactions.comment, `${TEST_PREFIX}%`));
      await tx.delete(cashCategories).where(like(cashCategories.name, `${TEST_PREFIX}%`));
      await tx.delete(cashAccounts).where(like(cashAccounts.name, `${TEST_PREFIX}%`));
    });
  }
}

async function balanceOf(accountId: string): Promise<bigint> {
  const accounts = await listAccounts(getDb(), erfolgId, { includeArchived: true });
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error('account not found');
  return BigInt(acc.balanceKopecks);
}

function mkAccount(name: string, kind: 'cash' | 'bank' | 'card', opening = 0n) {
  return createAccount(getDb(), erfolgId, {
    name: `${TEST_PREFIX}${name}`,
    kind,
    openingBalanceKopecks: opening,
  });
}

describe('cash balances materialization (этап A)', () => {
  beforeEach(clearTestData);

  it('новый счёт: balance = opening', async () => {
    const acc = await mkAccount('касса', 'cash', 500_00n);
    expect(acc.balanceKopecks).toBe('50000');
    expect(await balanceOf(acc.id)).toBe(50_000n);
  });

  it('доход увеличивает остаток, расход уменьшает', async () => {
    const acc = await mkAccount('касса', 'cash', 0n);
    const cat = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}прочее`,
      direction: 'income',
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: acc.id,
      categoryId: cat.id,
      amountKopecks: 100_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}in`,
      userId: null,
    });
    expect(await balanceOf(acc.id)).toBe(100_000n);

    const exp = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}аренда`,
      direction: 'expense',
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'expense',
      accountId: acc.id,
      categoryId: exp.id,
      amountKopecks: 30_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}out`,
      userId: null,
    });
    expect(await balanceOf(acc.id)).toBe(70_000n);
  });

  it('перевод: списывает с одного счёта и зачисляет на другой', async () => {
    const from = await mkAccount('касса', 'cash', 100_000n);
    const to = await mkAccount('банк', 'bank', 0n);
    await createTransaction(getDb(), erfolgId, {
      kind: 'transfer',
      accountId: from.id,
      counterAccountId: to.id,
      amountKopecks: 40_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}tr`,
      userId: null,
    });
    expect(await balanceOf(from.id)).toBe(60_000n);
    expect(await balanceOf(to.id)).toBe(40_000n);
  });

  it('удаление операции откатывает остаток', async () => {
    const acc = await mkAccount('касса', 'cash', 0n);
    const cat = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}доход`,
      direction: 'income',
    });
    const { id } = await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: acc.id,
      categoryId: cat.id,
      amountKopecks: 90_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}del`,
      userId: null,
    });
    expect(await balanceOf(acc.id)).toBe(90_000n);
    await deleteTransaction(getDb(), erfolgId, id);
    expect(await balanceOf(acc.id)).toBe(0n);
  });

  it('изменение стартового остатка пересчитывает текущий', async () => {
    const acc = await mkAccount('касса', 'cash', 10_000n);
    const cat = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}доход2`,
      direction: 'income',
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: acc.id,
      categoryId: cat.id,
      amountKopecks: 5_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}op`,
      userId: null,
    });
    expect(await balanceOf(acc.id)).toBe(15_000n);
    await updateAccount(getDb(), erfolgId, acc.id, { openingBalanceKopecks: 20_000n });
    expect(await balanceOf(acc.id)).toBe(25_000n); // 20000 opening + 5000 income
  });

  it('перевод на тот же счёт — ошибка', async () => {
    const acc = await mkAccount('касса', 'cash', 0n);
    await expect(
      createTransaction(getDb(), erfolgId, {
        kind: 'transfer',
        accountId: acc.id,
        counterAccountId: acc.id,
        amountKopecks: 1_000n,
        occurredOn: today,
        comment: `${TEST_PREFIX}self`,
        userId: null,
      }),
    ).rejects.toThrow(/тот же счёт/i);
  });

  it('статья не соответствует типу операции — ошибка', async () => {
    const acc = await mkAccount('касса', 'cash', 0n);
    const expenseCat = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}расход`,
      direction: 'expense',
    });
    await expect(
      createTransaction(getDb(), erfolgId, {
        kind: 'income',
        accountId: acc.id,
        categoryId: expenseCat.id,
        amountKopecks: 1_000n,
        occurredOn: today,
        comment: `${TEST_PREFIX}mismatch`,
        userId: null,
      }),
    ).rejects.toThrow(/не соответствует/i);
  });

  it('операция на несуществующий счёт — ошибка', async () => {
    await expect(
      createTransaction(getDb(), erfolgId, {
        kind: 'income',
        accountId: '00000000-0000-0000-0000-000000000000',
        amountKopecks: 1_000n,
        occurredOn: today,
        comment: `${TEST_PREFIX}noacc`,
        userId: null,
      }),
    ).rejects.toThrow(/Счёт не найден/i);
  });

  it('удаление счёта без операций — удаляет; с операциями — архивирует', async () => {
    const empty = await mkAccount('пустой', 'cash', 0n);
    expect(await deleteAccount(getDb(), erfolgId, empty.id)).toBe('deleted');

    const used = await mkAccount('с операцией', 'cash', 0n);
    const cat = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}д`,
      direction: 'income',
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: used.id,
      categoryId: cat.id,
      amountKopecks: 1_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}keep`,
      userId: null,
    });
    expect(await deleteAccount(getDb(), erfolgId, used.id)).toBe('archived');
  });
});
