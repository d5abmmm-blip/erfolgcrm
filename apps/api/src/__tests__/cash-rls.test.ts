/**
 * Касса (этап A) — RLS-изоляция между tenant'ами.
 * Счёт и операция, созданные в erfolg, не видны из demo (и наоборот).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { cashAccounts, cashCategories, cashTransactions, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createAccount,
  createCategory,
  createTransaction,
  listAccounts,
  listTransactions,
} from '../modules/cash/repository';

let erfolgId = '';
let demoId = '';

const TEST_PREFIX = 'TESTCASHRLS-';
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

describe('cash RLS isolation (этап A)', () => {
  beforeEach(clearTestData);

  it('счёт erfolg не виден из demo', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}секрет`,
      kind: 'cash',
    });
    const erfolgAccounts = await listAccounts(getDb(), erfolgId, { includeArchived: true });
    expect(erfolgAccounts.some((a) => a.id === acc.id)).toBe(true);

    const demoAccounts = await listAccounts(getDb(), demoId, { includeArchived: true });
    expect(demoAccounts.some((a) => a.id === acc.id)).toBe(false);
  });

  it('операция erfolg не видна в журнале demo', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}касса`,
      kind: 'cash',
    });
    const cat = await createCategory(getDb(), erfolgId, {
      name: `${TEST_PREFIX}д`,
      direction: 'income',
    });
    const { id } = await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: acc.id,
      categoryId: cat.id,
      amountKopecks: 5_000n,
      occurredOn: today,
      comment: `${TEST_PREFIX}op`,
      userId: null,
    });

    const erfolgTx = await listTransactions(getDb(), erfolgId, {}, 200, 0);
    expect(erfolgTx.items.some((t) => t.id === id)).toBe(true);

    const demoTx = await listTransactions(getDb(), demoId, {}, 200, 0);
    expect(demoTx.items.some((t) => t.id === id)).toBe(false);
  });
});
