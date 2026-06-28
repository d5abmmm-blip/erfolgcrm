/**
 * Продажи (sales + sale_items) ↔ касса.
 *   • createSale: позиции → материализованный total; getSale возвращает позиции и №;
 *   • paySale: доход в кассе на сумму продажи, остаток счёта растёт; isPaid=true;
 *   • unpaySale: доход убирается, остаток возвращается;
 *   • updateSale оплаченной продажи запрещён.
 *
 * clientId — произвольный uuid (FK на clients в схеме нет), имя не проверяем.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { cashAccounts, getDb, sales, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createAccount, getAccountBalances } from '../modules/cash/repository';
import { createSale, getSale, paySale, unpaySale, updateSale } from '../modules/sales/repository';

let erfolgId = '';
const TEST_PREFIX = 'TESTSALE-';

beforeAll(async () => {
  erfolgId = (await ensureSeed()).erfolgId;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.execute(
      sql`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE comment LIKE ${TEST_PREFIX + '%'})`,
    );
    await tx.execute(sql`DELETE FROM cash_transactions WHERE comment LIKE 'Продажа №%'`);
    await tx.delete(sales).where(like(sales.comment, `${TEST_PREFIX}%`));
    await tx.delete(cashAccounts).where(like(cashAccounts.name, `${TEST_PREFIX}%`));
  });
}

async function balanceOf(accountId: string): Promise<bigint> {
  const rep = await getAccountBalances(getDb(), erfolgId);
  return BigInt(rep.accounts.find((a) => a.id === accountId)?.balanceKopecks ?? '0');
}

const baseSale = () => ({
  clientId: uuidv7(),
  supplier: 'ООО Поставщик' as string | null,
  comment: `${TEST_PREFIX}заказ`,
  items: [
    { name: 'Датчик SpO2', quantity: 2, unitPriceKopecks: 150_000n, unitCostKopecks: 100_000n },
    { name: 'Кабель ЭКГ', quantity: 1, unitPriceKopecks: 50_000n, unitCostKopecks: 30_000n },
  ],
  createdBy: null,
});

describe('продажи ↔ касса', () => {
  beforeEach(clearTestData);

  it('createSale считает total из позиций и нумерует заказ', async () => {
    const { id } = await createSale(getDb(), erfolgId, baseSale());
    const sale = await getSale(getDb(), erfolgId, id);
    expect(sale).not.toBeNull();
    expect(sale!.totalKopecks).toBe('350000'); // 2*1500 + 1*500 = 3500 ₽
    expect(sale!.items).toHaveLength(2);
    expect(sale!.saleNo).toBeGreaterThan(0);
    expect(sale!.isPaid).toBe(false);
    // закупка = 2×1000 + 1×300 = 2300 ₽; маржа = 3500 − 2300 = 1200 ₽
    expect(sale!.marginKopecks).toBe('120000');
  });

  it('paySale проводит доход в кассу, отмена возвращает остаток', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 0n,
    });
    const { id } = await createSale(getDb(), erfolgId, baseSale());

    await paySale(getDb(), erfolgId, id, { accountId: acc.id, paidOn: '2026-06-20', userId: null });
    expect(await balanceOf(acc.id)).toBe(350_000n);
    expect((await getSale(getDb(), erfolgId, id))!.isPaid).toBe(true);

    await unpaySale(getDb(), erfolgId, id);
    expect(await balanceOf(acc.id)).toBe(0n);
    expect((await getSale(getDb(), erfolgId, id))!.isPaid).toBe(false);
  });

  it('повторная оплата продажи не задваивает доход в кассе', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 0n,
    });
    const { id } = await createSale(getDb(), erfolgId, baseSale());
    await paySale(getDb(), erfolgId, id, { accountId: acc.id, paidOn: '2026-06-20', userId: null });
    // Вторая оплата той же продажи отвергается (guard paidOn + FOR UPDATE против гонки).
    await expect(
      paySale(getDb(), erfolgId, id, { accountId: acc.id, paidOn: '2026-06-20', userId: null }),
    ).rejects.toThrow();
    // В кассе ровно один доход — остаток равен сумме продажи, а не удвоенной.
    expect(await balanceOf(acc.id)).toBe(350_000n);
  });

  it('редактирование оплаченной продажи запрещено', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 0n,
    });
    const { id } = await createSale(getDb(), erfolgId, baseSale());
    await paySale(getDb(), erfolgId, id, { accountId: acc.id, paidOn: '2026-06-20', userId: null });
    await expect(
      updateSale(getDb(), erfolgId, id, { comment: `${TEST_PREFIX}правка` }),
    ).rejects.toThrow();
  });
});
