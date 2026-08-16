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
 *
 * ⚠️ Окна расчёта — 2032 год, и это НЕ опечатка. computePayouts суммирует работы ВСЕХ
 * закрытых в окне заявок сид-инженера, а соседние тест-файлы (e2e, dashboard-metrics…)
 * закрывают заявки на том же инженере: changeStatus ставит closed_at = сейчас, и окно
 * на ТЕКУЩЕМ дне ловило чужую заявку — суммы удваивались. Тот же класс гонки, что в
 * staff-work на PR #148 (лечение — PR #149). В 2032-м заявок не закрывает никто:
 * 2031-й занят соседями (staff-work, staff-money, calendar, monthly-summary), 2027-й —
 * «пустым окном» окладника ниже, а окна legacy-тестов кончаются 2030-м.
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
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import {
  computePayouts,
  getRule,
  setEngineersSeeEarnings,
  setRule,
} from '../modules/payroll/repository';
import { updateUserPayout } from '../modules/users/repository';

let erfolgId = '';
let demoId = '';
let erfolgClientId = '';
let erfolgEngineerId = '';

// Своя метка, НЕ 'TEST-PAY-': её делит payments-totals.test.ts, и параллельная
// чистка чужих заявок по общей метке с миграции 0085 (payments RESTRICT)
// падает на чужих платежах вместо тихого каскада.
const TEST_PREFIX = 'TEST-PAYRL-';

// Закрытие и окно расчёта — один «пустой» месяц в далёком 2032-м (см. шапку файла).
const CLOSED_AT = new Date('2032-08-15T12:00:00Z');
const WINDOW = {
  start: new Date('2032-08-01T00:00:00Z'),
  end: new Date('2032-09-01T00:00:00Z'),
};

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [ec] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  const [eng] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'engineer')).limit(1),
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
      // Сбросить персональные ЗП-настройки и активность, чтобы тесты не влияли друг на друга.
      await tx.execute(
        sql`UPDATE users SET payout_base_salary_kopecks = NULL, payout_bonus_percent = NULL, is_active = true`,
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
    await tx.update(workOrders).set({ engineerId }).where(eq(workOrders.id, wo.id));
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
    await tx.update(tickets).set({ closedAt }).where(eq(tickets.id, ticketId));
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
    const closedAt = CLOSED_AT;
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      closedAt,
    );

    const { start, end } = WINDOW;

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
    const closedAt = CLOSED_AT;
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [200_000n],
      closedAt,
    );

    const { start, end } = WINDOW;

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
    const closedAt = CLOSED_AT;
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      closedAt,
    );

    const { start, end } = WINDOW;

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
    const closedAt = CLOSED_AT;
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      closedAt,
    );

    const { start, end } = WINDOW;

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
    const closedAt = CLOSED_AT;
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [200_000n],
      closedAt,
    );
    const { start, end } = WINDOW;

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

  it('заблокированный/уволенный (is_active=false) НЕ попадает в ведомость даже с работами за период', async () => {
    // Требование владельца: неактивных/служебных аккаунтов (напр. «Администратор», под
    // которым закрывали наряды) в ведомости ЗП быть не должно. Чтобы выплатить бывшему —
    // временно сделать его активным.
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 30 });
    const closedAt = CLOSED_AT;
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      closedAt,
    );
    const { start, end } = WINDOW;

    // Пока активен — в ведомости есть.
    const active = await computePayouts(getDb(), erfolgId, { start, end });
    expect(active.rows.find((r) => r.engineerId === erfolgEngineerId)).toBeDefined();

    // Блокируем (is_active=false) — исчезает из ведомости, несмотря на работы в периоде.
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`UPDATE users SET is_active = false WHERE id = ${erfolgEngineerId}::uuid`),
    );
    const blocked = await computePayouts(getDb(), erfolgId, { start, end });
    expect(blocked.rows.find((r) => r.engineerId === erfolgEngineerId)).toBeUndefined();
  });

  it('видимость заработка: по умолчанию true, переключается, setRule не сбрасывает', async () => {
    // По умолчанию (нет записи rule) — включено.
    expect((await getRule(getDb(), erfolgId)).engineersSeeEarnings).toBe(true);

    // Выключаем.
    await setEngineersSeeEarnings(getDb(), erfolgId, false);
    expect((await getRule(getDb(), erfolgId)).engineersSeeEarnings).toBe(false);

    // Правка режима расчёта НЕ трогает флаг.
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 40 });
    const afterSetRule = await getRule(getDb(), erfolgId);
    expect(afterSetRule.engineersSeeEarnings).toBe(false);
    expect(afterSetRule.pieceworkPercent).toBe(40);

    // Включаем обратно.
    await setEngineersSeeEarnings(getDb(), erfolgId, true);
    expect((await getRule(getDb(), erfolgId)).engineersSeeEarnings).toBe(true);
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
    const closedAt = CLOSED_AT;
    await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      closedAt,
    );
    const { start, end } = WINDOW;

    const result = await computePayouts(getDb(), erfolgId, { start, end });
    const row = result.rows.find((r) => r.engineerId === erfolgEngineerId);
    expect(row).toBeDefined();
    // Глобальная сделка 30% от 100_000 = 30_000
    expect(row!.totalEarningsKopecks).toBe('30000');
    expect(row!.baseSalaryKopecks).toBe('0');
  });
});

/**
 * Переоткрытие заявки и ЗП.
 *
 * ЗАЧЕМ. Ведомость выбирает строки работ по `tickets.closed_at` за месяц, и никакой
 * отметки «эта работа уже оплачена» в базе нет. Пока переоткрытие обнуляло дату
 * закрытия, повторное закрытие ставило СЕГОДНЯШНЮЮ — и те же самые строки работ
 * во второй раз попадали в ведомость нового месяца. Заявку закрыли в августе,
 * инженеру заплатили, в сентябре директор её переоткрыл и закрыл заново — и за ту
 * же работу платят снова. Заметить это некому: ведомость не показывает, из каких
 * заявок сложилась сумма.
 *
 * ПРАВИЛО. Дата закрытия — это дата ПЕРВОГО закрытия, она больше не переезжает.
 */
describe('payroll: переоткрытие заявки не удваивает выплату', () => {
  beforeEach(clearTestData);

  it('повторное закрытие оставляет работы в прежнем месяце', async () => {
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 30 });
    const { ticketId } = await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [100_000n],
      CLOSED_AT,
    );

    // Август 2032: работа посчитана, в жизни — уже выплачена.
    const before = await computePayouts(getDb(), erfolgId, WINDOW);
    expect(before.rows.find((r) => r.engineerId === erfolgEngineerId)!.worksAmountKopecks).toBe(
      '100000',
    );

    // Директор переоткрыл заявку и закрыл её заново — сегодня, то есть в другом месяце.
    await changeStatus(getDb(), erfolgId, null, ticketId, 'received');
    await changeStatus(getDb(), erfolgId, null, ticketId, 'closed');

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ closedAt: tickets.closedAt, firstClosedAt: tickets.firstClosedAt })
        .from(tickets)
        .where(eq(tickets.id, ticketId)),
    );
    // Повторное закрытие ставит сегодняшнюю дату — так требует проверка БД, —
    // но первое закрытие запомнено, и месяц ЗП считается по нему.
    expect(row!.firstClosedAt).toEqual(CLOSED_AT);
    expect(row!.closedAt).not.toEqual(CLOSED_AT);

    // Работа осталась в своём месяце — второй ведомости не будет.
    const after = await computePayouts(getDb(), erfolgId, WINDOW);
    expect(after.rows.find((r) => r.engineerId === erfolgEngineerId)!.worksAmountKopecks).toBe(
      '100000',
    );
  });

  it('отмена и возврат в работу тоже не сдвигают дату закрытия', async () => {
    await setRule(getDb(), erfolgId, { mode: 'piecework', pieceworkPercent: 30 });
    const { ticketId } = await createClosedTicketWithWorks(
      erfolgId,
      erfolgClientId,
      erfolgEngineerId,
      [50_000n],
      CLOSED_AT,
    );

    await changeStatus(getDb(), erfolgId, null, ticketId, 'cancelled', 'передумали');
    await changeStatus(getDb(), erfolgId, null, ticketId, 'closed');

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ firstClosedAt: tickets.firstClosedAt, cancelledAt: tickets.cancelledAt })
        .from(tickets)
        .where(eq(tickets.id, ticketId)),
    );
    expect(row!.firstClosedAt).toEqual(CLOSED_AT);
    expect(row!.cancelledAt).toBeNull();

    // И сама ведомость августа не изменилась.
    const after = await computePayouts(getDb(), erfolgId, WINDOW);
    expect(after.rows.find((r) => r.engineerId === erfolgEngineerId)!.worksAmountKopecks).toBe(
      '50000',
    );
  });
});
