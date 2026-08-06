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
import {
  createSale,
  getSale,
  paySale,
  salesAnalytics,
  unpaySale,
  updateSale,
} from '../modules/sales/repository';

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

  it('salesAnalytics: итоги, помесячно и топ-товаров по периоду (по дате продажи)', async () => {
    const db = getDb();
    // Две продажи в изолированном будущем месяце (2099-03), чтобы чужие данные не влияли.
    const s1 = await createSale(db, erfolgId, baseSale()); // total 3500 ₽, закупка 2300 ₽
    const s2 = await createSale(db, erfolgId, {
      ...baseSale(),
      items: [
        { name: 'Плата ИВЛ', quantity: 1, unitPriceKopecks: 500_000n, unitCostKopecks: 300_000n },
      ],
    }); // total 5000 ₽, закупка 3000 ₽
    await withTenantTx(db, erfolgId, async (tx) => {
      await tx.execute(
        sql`UPDATE sales SET created_at = '2099-03-10T10:00:00Z' WHERE id = ${s1.id}::uuid`,
      );
      await tx.execute(
        sql`UPDATE sales SET created_at = '2099-03-20T10:00:00Z' WHERE id = ${s2.id}::uuid`,
      );
    });

    const a = await salesAnalytics(db, erfolgId, { from: '2099-03-01', to: '2099-03-31' });
    expect(a.summary.revenueKopecks).toBe('850000'); // 350000 + 500000
    expect(a.summary.costKopecks).toBe('530000'); // 230000 + 300000
    expect(a.summary.profitKopecks).toBe('320000'); // 850000 − 530000
    expect(a.summary.salesCount).toBe(2);
    expect(a.summary.avgCheckKopecks).toBe('425000'); // 850000 / 2
    expect(a.summary.marginPercent).toBeCloseTo(37.6, 1); // 320000/850000 ≈ 37.6%
    expect(a.summary.unpaidKopecks).toBe('850000'); // обе не оплачены
    expect(a.summary.unpaidCount).toBe(2);

    const march = a.byMonth.find((m) => m.month === '2099-03');
    expect(march).toBeTruthy();
    expect(march!.revenueKopecks).toBe('850000');
    expect(march!.profitKopecks).toBe('320000');
    expect(march!.salesCount).toBe(2);

    // Топ товаров: «Плата ИВЛ» (выручка 5000 ₽) первым.
    expect(a.topProducts[0]?.name).toBe('Плата ИВЛ');
    expect(a.topProducts[0]?.revenueKopecks).toBe('500000');
  });
});
