/**
 * Касса (этап A) — агрегаты обзора и журнал.
 *   • getPeriodSummary: приход/расход/прибыль (дельта-подход, устойчив к фоновым данным);
 *   • expenseByCategory содержит нашу статью с верной суммой;
 *   • listTransactions: фильтр по счёту изолирует наши операции, total корректен;
 *   • getMonthlyFlow: текущий месяц учитывает наши суммы.
 *
 * Файлы тестов идут последовательно (fileParallelism:false) — дельта между
 * «до» и «после» отражает только операции этого теста.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { cashAccounts, cashCategories, cashTransactions, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createAccount,
  createCategory,
  createTransaction,
  getMonthlyFlow,
  getPeriodSummary,
  listTransactions,
} from '../modules/cash/repository';
import { resolvePeriod } from '../modules/cash/service';

let erfolgId = '';
let demoId = '';

const TEST_PREFIX = 'TESTCASHAGG-';
const today = new Date().toISOString().slice(0, 10);
const currentMonth = today.slice(0, 7);

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

describe('cash aggregates (этап A)', () => {
  beforeEach(clearTestData);

  it('getPeriodSummary считает приход/расход/прибыль (дельта)', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}касса`,
      kind: 'cash',
    });
    const inc = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}доход`,
      direction: 'income',
    });
    const exp = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}расход`,
      direction: 'expense',
    });

    const before = await getPeriodSummary(getDb(), erfolgId, resolvePeriod('month'));

    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: acc.id,
      categoryId: inc.id,
      amountKopecks: 200_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}i`,
      userId: null,
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'expense',
      accountId: acc.id,
      categoryId: exp.id,
      amountKopecks: 50_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}e`,
      userId: null,
    });
    // перевод не должен влиять на приход/расход
    const acc2 = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}банк`,
      kind: 'bank',
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'transfer',
      accountId: acc.id,
      counterAccountId: acc2.id,
      amountKopecks: 10_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}t`,
      userId: null,
    });

    const after = await getPeriodSummary(getDb(), erfolgId, resolvePeriod('month'));
    expect(BigInt(after.incomeKopecks) - BigInt(before.incomeKopecks)).toBe(200_000n);
    expect(BigInt(after.expenseKopecks) - BigInt(before.expenseKopecks)).toBe(50_000n);
    expect(BigInt(after.profitKopecks) - BigInt(before.profitKopecks)).toBe(150_000n);
  });

  it('expenseByCategory содержит нашу статью с верной суммой', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}касса`,
      kind: 'cash',
    });
    const exp = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}аренда`,
      direction: 'expense',
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'expense',
      accountId: acc.id,
      categoryId: exp.id,
      amountKopecks: 77_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}rent`,
      userId: null,
    });
    const summary = await getPeriodSummary(getDb(), erfolgId, resolvePeriod('month'));
    const row = summary.expenseByCategory.find((r) => r.categoryId === exp.id);
    expect(row).toBeDefined();
    expect(row?.amountKopecks).toBe('77000');
  });

  it('incomeByKind разносит приход по типу счёта (нал/карта/безнал)', async () => {
    const cashAcc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
    });
    const cardAcc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}карта`,
      kind: 'card',
    });
    const bankAcc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}банк2`,
      kind: 'bank',
    });
    const inc = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}д2`,
      direction: 'income',
    });

    const before = await getPeriodSummary(getDb(), erfolgId, resolvePeriod('today'));
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: cashAcc.id,
      categoryId: inc.id,
      amountKopecks: 30_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}c`,
      userId: null,
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: cardAcc.id,
      categoryId: inc.id,
      amountKopecks: 12_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}k`,
      userId: null,
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: bankAcc.id,
      categoryId: inc.id,
      amountKopecks: 50_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}b`,
      userId: null,
    });
    const after = await getPeriodSummary(getDb(), erfolgId, resolvePeriod('today'));

    expect(BigInt(after.incomeByKind.cashKopecks) - BigInt(before.incomeByKind.cashKopecks)).toBe(
      30_000n,
    );
    expect(BigInt(after.incomeByKind.cardKopecks) - BigInt(before.incomeByKind.cardKopecks)).toBe(
      12_000n,
    );
    expect(BigInt(after.incomeByKind.bankKopecks) - BigInt(before.incomeByKind.bankKopecks)).toBe(
      50_000n,
    );
  });

  it('listTransactions: фильтр по счёту изолирует операции, total верен', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}изоляция`,
      kind: 'cash',
    });
    const inc = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}д`,
      direction: 'income',
    });
    for (let i = 0; i < 3; i++) {
      await createTransaction(getDb(), erfolgId, {
        kind: 'income',
        accountId: acc.id,
        categoryId: inc.id,
        amountKopecks: BigInt((i + 1) * 1000),
        occurredOn: today,
        comment: `${TEST_PREFIX}n${i}`,
        userId: null,
      });
    }
    const page = await listTransactions(getDb(), erfolgId, { accountId: acc.id }, 50, 0);
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(3);
    expect(page.items.every((t) => t.accountId === acc.id)).toBe(true);
    expect(page.items[0]?.accountName).toBe(`${TEST_PREFIX}изоляция`);

    const onlyIncome = await listTransactions(
      getDb(),
      erfolgId,
      { accountId: acc.id, kind: 'expense' },
      50,
      0,
    );
    expect(onlyIncome.total).toBe(0);
  });

  it('getMonthlyFlow учитывает суммы текущего месяца', async () => {
    const acc = await createAccount(getDb(), erfolgId, { name: `${TEST_PREFIX}мес`, kind: 'cash' });
    const inc = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}дм`,
      direction: 'income',
    });

    const before = await getMonthlyFlow(getDb(), erfolgId, 6);
    const beforeIncome = BigInt(before.find((m) => m.month === currentMonth)?.incomeKopecks ?? '0');

    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: acc.id,
      categoryId: inc.id,
      amountKopecks: 123_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}m`,
      userId: null,
    });

    const after = await getMonthlyFlow(getDb(), erfolgId, 6);
    const afterIncome = BigInt(after.find((m) => m.month === currentMonth)?.incomeKopecks ?? '0');
    expect(afterIncome - beforeIncome).toBe(123_000n);
  });
});
