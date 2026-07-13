/**
 * Ручная ведомость выплат (payroll_sheets).
 *
 * Проверяем:
 *   1. save создаёт ведомость; getByMonth и list её возвращают (суммы в копейках).
 *   2. Перезапись существующего месяца без причины падает; с причиной — обновляет.
 *   3. Удаление мягкое: месяц исчезает из list/getByMonth и заводится заново без причины.
 *   4. delete несуществующей → NOT_FOUND.
 *   5. Cross-tenant: ведомость erfolg не видна из demo (RLS).
 *
 * Месяцы 2099-* — заведомо «пустые», чтобы не задеть реальные/seed-данные.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, isNull, like } from 'drizzle-orm';
import {
  cashAccounts,
  cashTransactions,
  getDb,
  payrollSheets,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  deleteSheet,
  getSheetByMonth,
  listSheets,
  postToCash,
  saveSheet,
  unpostFromCash,
} from '../modules/payroll/sheets';
import type { CmdCtx } from '../trpc/helpers';

let erfolgId = '';
let demoId = '';
let actingUserId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [u] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).limit(1),
  );
  if (!u) throw new Error('seed missing user');
  actingUserId = u.id;
});

function ctxFor(tenantId: string): CmdCtx {
  return {
    db: getDb(),
    tenant: { id: tenantId },
    session: { userId: actingUserId },
    audit: { ip: null, userAgent: null },
  } as unknown as CmdCtx;
}

async function clearSheets(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, (tx) =>
      tx.delete(payrollSheets).where(like(payrollSheets.month, '2099-%')),
    );
  }
}

const entry = (salaryKopecks: number, advanceKopecks = 0, bonusKopecks = 0, name = 'Иванов И.') => ({
  employeeId: 'manual_test',
  employeeName: name,
  salaryKopecks,
  pieceworkKopecks: 0,
  advanceKopecks,
  bonusKopecks,
});

describe('payroll sheets (ручная ведомость)', () => {
  beforeEach(clearSheets);

  it('save создаёт ведомость, getByMonth и list её возвращают', async () => {
    const saved = await saveSheet(ctxFor(erfolgId), {
      month: '2099-01',
      entries: [entry(4_000_000, 1_000_000, 500_000)],
    });
    expect(saved.month).toBe('2099-01');
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]?.salaryKopecks).toBe(4_000_000);
    expect(saved.savedAt).toBeTruthy();

    const fetched = await getSheetByMonth(getDb(), erfolgId, '2099-01');
    expect(fetched?.entries[0]?.advanceKopecks).toBe(1_000_000);
    expect(fetched?.entries[0]?.bonusKopecks).toBe(500_000);

    const list = await listSheets(getDb(), erfolgId);
    expect(list.some((s) => s.month === '2099-01')).toBe(true);
  });

  it('перезапись без причины падает, с причиной — обновляет', async () => {
    await saveSheet(ctxFor(erfolgId), { month: '2099-02', entries: [entry(1_000_000)] });

    await expect(
      saveSheet(ctxFor(erfolgId), { month: '2099-02', entries: [entry(2_000_000)] }),
    ).rejects.toThrow(/причин/i);

    const updated = await saveSheet(ctxFor(erfolgId), {
      month: '2099-02',
      entries: [entry(2_000_000)],
      reason: 'исправлен оклад по договору',
    });
    expect(updated.entries[0]?.salaryKopecks).toBe(2_000_000);

    const fetched = await getSheetByMonth(getDb(), erfolgId, '2099-02');
    expect(fetched?.entries[0]?.salaryKopecks).toBe(2_000_000);
  });

  it('удаление мягкое: месяц исчезает и заводится заново без причины', async () => {
    await saveSheet(ctxFor(erfolgId), { month: '2099-03', entries: [entry(1_000_000)] });
    await deleteSheet(ctxFor(erfolgId), '2099-03');
    expect(await getSheetByMonth(getDb(), erfolgId, '2099-03')).toBeNull();

    // Живой ведомости нет → повторное сохранение НЕ требует причины (не перезапись).
    const resaved = await saveSheet(ctxFor(erfolgId), {
      month: '2099-03',
      entries: [entry(3_000_000)],
    });
    expect(resaved.entries[0]?.salaryKopecks).toBe(3_000_000);
  });

  it('delete несуществующей ведомости → NOT_FOUND', async () => {
    await expect(deleteSheet(ctxFor(erfolgId), '2099-09')).rejects.toThrow();
  });

  it('cross-tenant: ведомость erfolg не видна из demo', async () => {
    await saveSheet(ctxFor(erfolgId), { month: '2099-04', entries: [entry(1_000_000)] });
    const demoList = await listSheets(getDb(), demoId);
    expect(demoList.some((s) => s.month === '2099-04')).toBe(false);
    expect(await getSheetByMonth(getDb(), demoId, '2099-04')).toBeNull();
  });
});

describe('payroll sheets — проведение в кассу', () => {
  beforeEach(clearSheets);

  it('postToCash создаёт расход и уменьшает остаток; unpost возвращает', async () => {
    const [acc] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .insert(cashAccounts)
        .values({
          tenantId: erfolgId,
          name: 'ТЕСТ-ЗП-счёт',
          kind: 'cash',
          openingBalanceKopecks: 1_000_000n,
          balanceKopecks: 1_000_000n,
        })
        .returning({ id: cashAccounts.id }),
    );
    const accountId = acc!.id;
    try {
      // Ведомость на 8 000 ₽ (оклад 5000 + сделка 3000).
      await saveSheet(ctxFor(erfolgId), {
        month: '2099-05',
        entries: [
          {
            employeeId: 'manual_x',
            employeeName: 'Пётр',
            salaryKopecks: 500_000,
            pieceworkKopecks: 300_000,
            advanceKopecks: 0,
            bonusKopecks: 0,
          },
        ],
      });

      const posted = await postToCash(ctxFor(erfolgId), '2099-05', accountId);
      expect(posted.cashTransactionId).toBeTruthy();
      expect(posted.postedAmountKopecks).toBe('800000');

      const [tx1] = await withTenantTx(getDb(), erfolgId, (tx) =>
        tx
          .select()
          .from(cashTransactions)
          .where(
            and(
              eq(cashTransactions.id, posted.cashTransactionId!),
              isNull(cashTransactions.deletedAt),
            ),
          )
          .limit(1),
      );
      expect(tx1?.kind).toBe('expense');
      expect(String(tx1?.amountKopecks)).toBe('800000');

      // Остаток: 1 000 000 − 800 000 = 200 000.
      const [a1] = await withTenantTx(getDb(), erfolgId, (tx) =>
        tx
          .select({ b: cashAccounts.balanceKopecks })
          .from(cashAccounts)
          .where(eq(cashAccounts.id, accountId))
          .limit(1),
      );
      expect(String(a1?.b)).toBe('200000');

      // Отмена проведения → ссылка снята, расход мягко удалён, остаток вернулся.
      const un = await unpostFromCash(ctxFor(erfolgId), '2099-05');
      expect(un.cashTransactionId).toBeNull();

      const [tx2] = await withTenantTx(getDb(), erfolgId, (tx) =>
        tx
          .select({ d: cashTransactions.deletedAt })
          .from(cashTransactions)
          .where(eq(cashTransactions.id, posted.cashTransactionId!))
          .limit(1),
      );
      expect(tx2?.d).not.toBeNull();

      const [a2] = await withTenantTx(getDb(), erfolgId, (tx) =>
        tx
          .select({ b: cashAccounts.balanceKopecks })
          .from(cashAccounts)
          .where(eq(cashAccounts.id, accountId))
          .limit(1),
      );
      expect(String(a2?.b)).toBe('1000000');
    } finally {
      await withTenantTx(getDb(), erfolgId, async (tx) => {
        await tx.delete(cashTransactions).where(eq(cashTransactions.accountId, accountId));
        await tx.delete(cashAccounts).where(eq(cashAccounts.id, accountId));
      });
    }
  });

  it('нельзя провести несохранённую ведомость (NOT_FOUND)', async () => {
    const [acc] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .insert(cashAccounts)
        .values({ tenantId: erfolgId, name: 'ТЕСТ-ЗП-счёт2', kind: 'cash' })
        .returning({ id: cashAccounts.id }),
    );
    try {
      await expect(postToCash(ctxFor(erfolgId), '2099-08', acc!.id)).rejects.toThrow();
    } finally {
      await withTenantTx(getDb(), erfolgId, (tx) =>
        tx.delete(cashAccounts).where(eq(cashAccounts.id, acc!.id)),
      );
    }
  });
});
