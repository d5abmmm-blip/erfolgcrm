/**
 * Плитка «Выручка» на главной и «Собрано» в разделе «Финансы» — одно число.
 *
 * ЧТО БЫЛО. Плитка считалась по таблице `payments` (оплаты, заведённые кнопкой
 * «Внести платёж» в заявке), а «Собрано» — по кассе. В кассу же доход попадает
 * четырьмя путями: ручная операция, оплата продажи, внутреннее внесение и автосинк
 * из payments. То есть касса ⊇ payments, и плитка систематически занижала.
 *
 * На боевой базе оплату ведут КАССОЙ, а payments пуст — директор видел на главной
 * 0 ₽ выручки при полной кассе.
 *
 * Считаем дельту: соседние тесты тоже пишут в кассу, а файлы идут последовательно.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { cashAccounts, cashCategories, cashTransactions, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createAccount, createCategory, createTransaction } from '../modules/cash/repository';
import { getPeriodSummary } from '../modules/cash/repository';
import { resolvePeriod } from '../modules/cash/service';
import { getMetrics } from '../modules/dashboard/repository';

const PREFIX = 'TEST-DASHREV-';
const today = new Date().toISOString().slice(0, 10);

let erfolgId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(cashTransactions).where(like(cashTransactions.comment, `${PREFIX}%`));
    await tx.delete(cashCategories).where(like(cashCategories.name, `${PREFIX}%`));
    await tx.delete(cashAccounts).where(like(cashAccounts.name, `${PREFIX}%`));
  });
});

describe('выручка на главной = собрано в кассе', () => {
  it('приход, заведённый кассой, попадает в плитку «Выручка»', async () => {
    const period = resolvePeriod('month');
    const beforeTile = BigInt((await getMetrics(getDb(), erfolgId, period)).revenuePeriodKopecks);

    const acc = await createAccount(getDb(), erfolgId, { name: `${PREFIX}касса`, kind: 'cash' });
    const cat = await createCategory(getDb(), erfolgId, {
      name: `${PREFIX}доход`,
      direction: 'income',
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: acc.id,
      categoryId: cat.id,
      amountKopecks: 5_000_000n, // 50 000 ₽ приняли кассой, минуя «Внести платёж»
      occurredOn: today,
      comment: `${PREFIX}приход`,
      userId: null,
    });

    const afterTile = BigInt((await getMetrics(getDb(), erfolgId, period)).revenuePeriodKopecks);
    expect(afterTile - beforeTile).toBe(5_000_000n);
  });

  it('плитка и «Собрано» на /finance дают одно и то же число', async () => {
    const period = resolvePeriod('month');
    const acc = await createAccount(getDb(), erfolgId, { name: `${PREFIX}касса2`, kind: 'cash' });
    const cat = await createCategory(getDb(), erfolgId, {
      name: `${PREFIX}доход2`,
      direction: 'income',
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId: acc.id,
      categoryId: cat.id,
      amountKopecks: 1_234_500n,
      occurredOn: today,
      comment: `${PREFIX}приход2`,
      userId: null,
    });

    const tile = (await getMetrics(getDb(), erfolgId, period)).revenuePeriodKopecks;
    const finance = (await getPeriodSummary(getDb(), erfolgId, period)).incomeKopecks;
    expect(tile).toBe(finance);
  });
});
