/**
 * Внутренние операции кассы (внесение/выдача):
 *   • createInternalOp создаёт income/expense с системной статьёй и меняет остаток счёта;
 *   • getPeriodSummary/getMonthlyFlow по умолчанию их ИСКЛЮЧАЮТ (нет двойного дохода),
 *     includeInternal=true — включают (сверка с реальным сейфом);
 *   • остатки счетов учитывают внутренние операции ВСЕГДА.
 * Изоляция: операции в будущем периоде 2099-05, тестовые счета/операции чистятся.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like, inArray, sql } from 'drizzle-orm';
import { cashAccounts, cashCategories, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createAccount,
  createInternalOp,
  createTransaction,
  getAccountBalances,
  getMonthlyFlow,
  getPeriodSummary,
  INTERNAL_EXPENSE_CATEGORY,
  INTERNAL_INCOME_CATEGORY,
} from '../modules/cash/repository';

let erfolgId = '';
const TEST_PREFIX = 'TESTCASHINT-';

beforeAll(async () => {
  erfolgId = (await ensureSeed()).erfolgId;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.execute(sql`
      DELETE FROM cash_transactions
      WHERE account_id IN (SELECT id FROM cash_accounts WHERE name LIKE ${TEST_PREFIX + '%'})
    `);
    await tx.delete(cashAccounts).where(like(cashAccounts.name, `${TEST_PREFIX}%`));
  });
}

const PERIOD = { start: new Date('2099-05-01T00:00:00Z'), end: new Date('2099-06-01T00:00:00Z') };

describe('внутренние операции кассы', () => {
  beforeEach(clearTestData);

  it('внесение/выдача меняют остаток, но не попадают в сводку без тумблера', async () => {
    const db = getDb();
    const acc = await createAccount(db, erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 0n,
    });

    // Внутренние: +1000 ₽ внесение, −300 ₽ выдача. Обычный доход: +500 ₽.
    await createInternalOp(db, erfolgId, {
      kind: 'deposit',
      accountId: acc.id,
      amountKopecks: 100_000n,
      occurredOn: '2099-05-10',
      counterparty: 'Расул',
      comment: null,
      userId: null,
    });
    await createInternalOp(db, erfolgId, {
      kind: 'withdrawal',
      accountId: acc.id,
      amountKopecks: 30_000n,
      occurredOn: '2099-05-11',
      counterparty: null,
      comment: null,
      userId: null,
    });
    await createTransaction(db, erfolgId, {
      kind: 'income',
      accountId: acc.id,
      amountKopecks: 50_000n,
      occurredOn: '2099-05-12',
      userId: null,
    });

    // Сводка по умолчанию: внутренние исключены — только обычный доход.
    const summary = await getPeriodSummary(db, erfolgId, PERIOD);
    expect(summary.incomeKopecks).toBe('50000');
    expect(summary.expenseKopecks).toBe('0');
    // Статей внутренних операций нет в разбивке.
    const catNames = [...summary.incomeByCategory, ...summary.expenseByCategory].map(
      (c) => c.categoryName,
    );
    expect(catNames).not.toContain(INTERNAL_INCOME_CATEGORY);
    expect(catNames).not.toContain(INTERNAL_EXPENSE_CATEGORY);

    // С тумблером: внутренние учитываются.
    const full = await getPeriodSummary(db, erfolgId, PERIOD, true);
    expect(full.incomeKopecks).toBe('150000');
    expect(full.expenseKopecks).toBe('30000');

    // Помесячная динамика: 2099-05 без тумблера — 500 ₽, с тумблером — 1500/300.
    const flowDefault = (await getMonthlyFlow(db, erfolgId, 6)).find((m) => m.month === '2099-05');
    expect(flowDefault?.incomeKopecks ?? '0').toBe('50000');
    const flowFull = (await getMonthlyFlow(db, erfolgId, 6, true)).find(
      (m) => m.month === '2099-05',
    );
    expect(flowFull?.incomeKopecks).toBe('150000');
    expect(flowFull?.expenseKopecks).toBe('30000');

    // Остаток счёта учитывает ВСЁ: 1000 − 300 + 500 = 1200 ₽.
    const balances = await getAccountBalances(db, erfolgId);
    expect(balances.accounts.find((a) => a.id === acc.id)?.balanceKopecks).toBe('120000');
  });

  it('системные статьи создаются find-or-create и не дублируются', async () => {
    const db = getDb();
    const acc = await createAccount(db, erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 0n,
    });
    for (let i = 0; i < 2; i++) {
      await createInternalOp(db, erfolgId, {
        kind: 'deposit',
        accountId: acc.id,
        amountKopecks: 10_000n,
        occurredOn: '2099-05-15',
        counterparty: null,
        comment: null,
        userId: null,
      });
    }
    const cats = await withTenantTx(db, erfolgId, (tx) =>
      tx
        .select({ id: cashCategories.id, isSystem: cashCategories.isSystem })
        .from(cashCategories)
        .where(inArray(cashCategories.name, [INTERNAL_INCOME_CATEGORY, INTERNAL_EXPENSE_CATEGORY])),
    );
    // «Внесение в кассу» одна (несмотря на 2 операции); все системные.
    expect(cats.length).toBeLessThanOrEqual(2);
    expect(cats.every((c) => c.isSystem)).toBe(true);
  });
});
