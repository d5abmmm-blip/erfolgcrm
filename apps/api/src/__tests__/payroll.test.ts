/**
 * Этап 9.C — payroll: правила расчёта + ЗП по периоду.
 *
 * Проверяем:
 *   1. getRule по умолчанию (если запись отсутствует) возвращает piecework 30%.
 *   2. setRule создаёт singleton, повторный setRule — апдейтит.
 *   3. Cross-tenant: rule для erfolg не виден из demo.
 *   4. computePayouts piecework: правильный расчёт по работам закрытых WO.
 *   5. computePayouts salary_bonus: оклад + бонус%.
 *   6. computePayouts учитывает только закрытые в окне ticket'ы.
 *   7. computePayouts атрибутирует работу через line.engineer_id (а не только wo.engineer_id).
 *   8. myEarnings (через computePayouts с engineerId) — фильтр работает.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import {
  clients,
  engineerPayoutRules,
  getDb,
  tickets,
  users,
  withTenantTx,
  workOrders,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket, changeStatus } from '../modules/tickets/repository';
import {
  getOrCreateWorkOrder,
  upsertLine,
} from '../modules/work-orders/repository';
import {
  computePayouts,
  getRule,
  setRule,
} from '../modules/payroll/repository';
import { updateUserPayout } from '../modules/users/repository';

let erfolgId = '';
let demoId = '';
let erfolgClientId = '';
let erfolgEngineerId = '';

const TEST_PREFIX = 'TEST-PAY-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [ec] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  const [eng] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'engineer'))
      .limit(1),
  );
  if (!ec || !eng) throw new Error('seed missing client/engineer');
  erfolgClientId = ec.id;
  erfolgEngineerId = eng.id;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.execute(sql`
        DELETE FROM work_order_lines
         WHERE work_order_id IN (
           SELECT wo.id FROM work_orders wo
             JOIN tickets t ON t.id = wo.ticket_id
            WHERE t.symptom LIKE ${TEST_PREFIX + '%'}
         )
      `);
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
      await tx.delete(engineerPayoutRules);
      // Сбросить персональные ЗП-настройки, чтобы тесты не влияли друг на друга.
      await tx.execute(
        sql`UPDATE users SET payout_base_salary_kopecks = NULL, payout_bonus_percent = NULL`,
      );
    });
  }
}

async function createClosedTicketWithWorks(
  tenantId: string,
  clientId: string,
  engineerId: string,
  workAmounts: bigint[],
  closedAt: Date,
): Promise<{ ticketId: string; workOrderId: string }> {
  const { id: ticketId } = await createTicket(getDb(), tenantId, null, {
    clientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), tenantId, ticketId);
  // Привязываем главного инженера к WO
  await withTenantTx(getDb(), tenantId, async (tx) => {
    await tx
      .update(workOrders)
      .set({ engineerId })
      .where(eq(workOrders.id, wo.id));
  });
  for (const amount of workAmounts) {
    await upsertLine(getDb(), tenantId, wo.id, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}work`,
      unit: 'час',
      quantity: '1',
      unitPriceKopecks: amount,
      engineerId,
    });
  }
  await changeStatus(getDb(), tenantId, null, ticketId, 'closed');
  await withTenantTx(getDb(), tenantId, async (tx) => {
    await tx
      .update(tickets)
      .set({ closedAt })
      .where(eq(tickets.id, ticketId));
  });
  return { ticketId, workOrderId: wo.id };
}

describe('payroll rules', () => {
  beforeEach(clearTestData);

  it('getRule по умолчанию = piecework 30%', async () => {
    const rule = await getRule(getDb(), erfolgId);
    expect(rule.mode).toBe('piecework');
    expect(rule.pieceworkPercent).toBe(30);
    expect(rule.baseSalaryKopecks).toBe('0');
  });

  it('setRule создаёт и обновляет singleton', async () => {
    const r1 = await setRule(getDb(), erfolgId, {
      mode: 'salary_bonus',
      baseSalaryKopecks: 5_000_000n,
      bonusPercent: 10,
    });
    expect(r1.mode).toBe('salary_bonus');
    expect(r1.baseSalaryKopecks).toBe('5000000');

    const r2 = await setRule(getDb(), erfolgId, {
      mode: 'piecework',
      pieceworkPercent: 40,
    });
    expect(r2.mode).toBe('piecework');
    expect(r2.pieceworkPercent).toBe(40);

    const fetched = await getRule(getDb(), erfolgId);
    expect(fetched.pieceworkPercent).toBe(40);
  });

  it('cross-tenant: rule erfolg не виден из demo', async () => {
    await setRule(getDb(), erfolgId, { mode: 'salary_bonus' });
    const demoRule = await getRule(getDb(), demoId);
    expect(demoRule.mode).toBe('piecework'); // default
  });
});

describe('payroll compute', () => {
  beforeEach(clearTestData);

  it('piecework 30% от 100_000 = 30_000', async () => {
    await setRule(getDb(), erfolgId, {
      mode: 'piecework',
      pieceworkPercent: 30,
    });
    const closedAt = new Date();
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      closedAt,
    );

    const start = new Date(closedAt);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const result = await computePayouts(getDb(), erfolgId, { start, end });
    const row = result.rows.find((r) => r.engineerId === erfolgEngineerId);
    expect(row).toBeDefined();
    expect(row!.worksAmountKopecks).toBe('100000');
    expect(row!.pieceworkPartKopecks).toBe('30000');
    expect(row!.totalEarningsKopecks).toBe('30000');
    expect(row!.baseSalaryKopecks).toBe('0');
  });

  it('salary_bonus: оклад + бонус%', async () => {
    await setRule(getDb(), erfolgId, {
      mode: 'salary_bonus',
      baseSalaryKopecks: 50_000_000n, // 500 000 ₽
      bonusPercent: 10,
    });
    const closedAt = new Date();
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [200_000n],
      closedAt,
    );

    const start = new Date(closedAt);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const result = await computePayouts(getDb(), erfolgId, { start, end });
    const row = result.rows.find((r) => r.engineerId === erfolgEngineerId);
    expect(row).toBeDefined();
    // base 50_000_000 + 10% от 200_000 = 50_020_000
    expect(row!.baseSalaryKopecks).toBe('50000000');
    expect(row!.pieceworkPartKopecks).toBe('20000');
    expect(row!.totalEarningsKopecks).toBe('50020000');
  });

  it('учитывает только закрытые в окне периода', async () => {
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 30 });
    // Используем заведомо «пустое» окно в далёком прошлом, чтобы seed не мешал
    const inWindow = new Date('2026-01-15T12:00:00Z');
    const outOfWindow = new Date('2025-12-15T12:00:00Z');
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      inWindow,
    );
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [500_000n],
      outOfWindow,
    );

    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-02-01T00:00:00Z');
    const result = await computePayouts(getDb(), erfolgId, { start, end });
    const row = result.rows.find((r) => r.engineerId === erfolgEngineerId);
    expect(row).toBeDefined();
    expect(row!.worksAmountKopecks).toBe('100000'); // только в окне
  });

  it('фильтр engineerId возвращает только этого инженера', async () => {
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 50 });
    const closedAt = new Date();
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      closedAt,
    );

    const start = new Date(closedAt);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const result = await computePayouts(
      getDb(),
      erfolgId,
      { start, end },
      { engineerId: erfolgEngineerId },
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.engineerId).toBe(erfolgEngineerId);
    expect(result.grandTotalKopecks).toBe('50000');
  });

  it('cross-tenant: payouts erfolg не видны из demo', async () => {
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 30 });
    const closedAt = new Date();
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      closedAt,
    );

    const start = new Date(closedAt);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const demoResult = await computePayouts(getDb(), demoId, { start, end });
    expect(demoResult.rows.find((r) => r.engineerId === erfolgEngineerId)).toBeUndefined();
  });
});

describe('payroll персональные правила', () => {
  beforeEach(clearTestData);

  it('персональный оклад+бонус перекрывает глобальное правило', async () => {
    // Глобально — сделка 30%, но у сотрудника личное: оклад 100_000 + бонус 10%.
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 30 });
    await updateUserPayout(getDb(), erfolgId, erfolgEngineerId, {
      baseSalaryKopecks: 100_000n,
      bonusPercent: 10,
    });
    const closedAt = new Date();
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [200_000n],
      closedAt,
    );
    const start = new Date(closedAt);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const result = await computePayouts(getDb(), erfolgId, { start, end });
    const row = result.rows.find((r) => r.engineerId === erfolgEngineerId);
    expect(row).toBeDefined();
    // 100_000 оклад + 10% от 200_000 = 120_000 (а НЕ 30% глобальной сделки)
    expect(row!.baseSalaryKopecks).toBe('100000');
    expect(row!.pieceworkPartKopecks).toBe('20000');
    expect(row!.totalEarningsKopecks).toBe('120000');
  });

  it('окладник без работ за период попадает в расчёт со своим окладом', async () => {
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 30 });
    await updateUserPayout(getDb(), erfolgId, erfolgEngineerId, {
      baseSalaryKopecks: 500_000n,
      bonusPercent: 0,
    });
    // Пустое будущее окно — работ нет вообще.
    const start = new Date('2027-01-01T00:00:00Z');
    const end = new Date('2027-02-01T00:00:00Z');
    const result = await computePayouts(getDb(), erfolgId, { start, end });
    const row = result.rows.find((r) => r.engineerId === erfolgEngineerId);
    expect(row).toBeDefined();
    expect(row!.worksAmountKopecks).toBe('0');
    expect(row!.totalEarningsKopecks).toBe('500000');
  });

  it('сброс персонального правила (null) возвращает к глобальному', async () => {
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 30 });
    await updateUserPayout(getDb(), erfolgId, erfolgEngineerId, {
      baseSalaryKopecks: 999_999n,
      bonusPercent: 50,
    });
    await updateUserPayout(getDb(), erfolgId, erfolgEngineerId, {
      baseSalaryKopecks: null,
      bonusPercent: null,
    });
    const closedAt = new Date();
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      closedAt,
    );
    const start = new Date(closedAt);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const result = await computePayouts(getDb(), erfolgId, { start, end });
    const row = result.rows.find((r) => r.engineerId === erfolgEngineerId);
    expect(row).toBeDefined();
    // Глобальная сделка 30% от 100_000 = 30_000
    expect(row!.totalEarningsKopecks).toBe('30000');
    expect(row!.baseSalaryKopecks).toBe('0');
  });
});
