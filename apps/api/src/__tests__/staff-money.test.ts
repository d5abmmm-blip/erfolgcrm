/**
 * Вкладка «Деньги» на карточке сотрудника — payroll.staffMoney (только директор).
 *
 * Правила, ради которых тесты:
 *
 * 1. Уволенному расчёт НЕ показывается вовсе. computePayouts не видит неактивных
 *    (u.is_active = true в обоих запросах), поэтому «начислено» у бывшего вышло бы
 *    не пустотой, а «0 ₽» — читается как «ничего не заработал». Вместо нулей — null,
 *    экран объясняет словами. История выплат и ведомостей при этом остаётся.
 *
 * 2. «К выплате» по строке ведомости — max(0, начислено − аванс) ПО КАЖДОЙ строке,
 *    та же формула, что при проведении в кассу (sheets.ts): долг одного месяца не
 *    уменьшает выплату другого.
 *
 * 3. Деньги — directorProcedure: менеджеру (dispatcher) отказ.
 *
 * Логика «кому что видно» проверяется ЧИСТЫМИ тестами без базы: payroll.test.ts в
 * beforeEach обнуляет payout_* и is_active у ВСЕХ пользователей, а vitest гоняет
 * файлы параллельно — интеграционный тест на этих полях мигал бы (см.
 * labor-cost-percent.test.ts). Интеграционные тесты — только про независимое от
 * payout_* и is_active: роли, историю выплат, строки ведомостей.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  cashAccounts,
  cashTransactions,
  getDb,
  payrollPayouts,
  payrollSheets,
  users,
  withTenantTx,
  type PayrollSheetEntry,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';
import { createAccount } from '../modules/cash/repository';
import {
  createPayout,
  type PayoutBreakdown,
  type PayoutDto,
  type PayrollRule,
} from '../modules/payroll/repository';
import type { PayrollSheetDto } from '../modules/payroll/sheets';
import { buildStaffMoney } from '../modules/payroll/staff-money';

/* ────────────────────── чистая часть: buildStaffMoney ────────────────────── */

function rule(over: Partial<PayrollRule> = {}): PayrollRule {
  return {
    tenantId: 't',
    mode: 'piecework',
    pieceworkPercent: 30,
    baseSalaryKopecks: '0',
    bonusPercent: 0,
    engineersSeeEarnings: true,
    updatedAt: new Date(0),
    ...over,
  };
}

function user(over: Partial<Parameters<typeof buildStaffMoney>[0]['user']> = {}) {
  return {
    userId: 'u1',
    fullName: 'Тестов Тест',
    isActive: true,
    baseSalaryKopecks: null as bigint | null,
    bonusPercent: null as number | null,
    ...over,
  };
}

function breakdown(over: Partial<PayoutBreakdown> = {}): PayoutBreakdown {
  return {
    engineerId: 'u1',
    engineerName: 'Тестов Тест',
    worksAmountKopecks: '100000',
    closedOrdersTotalKopecks: '200000',
    closedOrdersCount: 2,
    baseSalaryKopecks: '0',
    pieceworkPartKopecks: '30000',
    totalEarningsKopecks: '30000',
    ...over,
  };
}

function entry(over: Partial<PayrollSheetEntry> = {}): PayrollSheetEntry {
  return {
    employeeId: 'u1',
    employeeName: 'Тестов Тест',
    salaryKopecks: 4_000_000,
    pieceworkKopecks: 0,
    advanceKopecks: 0,
    bonusKopecks: 0,
    ...over,
  };
}

function sheet(
  month: string,
  entries: PayrollSheetEntry[],
  opts: { posted?: boolean } = {},
): PayrollSheetDto {
  return {
    id: `sheet-${month}`,
    month,
    entries,
    savedAt: '2026-08-01T00:00:00.000Z',
    cashTransactionId: opts.posted ? 'cash-tx' : null,
    postedAmountKopecks: null,
    postedAccountId: null,
    postedAt: null,
  };
}

function payout(over: Partial<PayoutDto> = {}): PayoutDto {
  return {
    id: uuidv7(),
    engineerId: 'u1',
    kind: 'final',
    periodStart: '2026-07-01',
    periodEnd: '2026-08-01',
    periodLabel: 'Месяц',
    computedKopecks: '30000',
    amountKopecks: '30000',
    paidOn: '2026-07-31',
    accountId: 'acc',
    cashTransactionId: null,
    comment: null,
    createdAt: '2026-07-31T10:00:00.000Z',
    ...over,
  };
}

describe('buildStaffMoney: уволенный', () => {
  it('расчёт скрыт (null), даже если computePayouts что-то вернул', () => {
    const dto = buildStaffMoney({
      user: user({ isActive: false, bonusPercent: 99 }),
      rule: rule(),
      earnings: breakdown(),
      payouts: [],
      sheets: [],
    });
    expect(dto.isActive).toBe(false);
    expect(dto.earnings).toBeNull();
  });

  it('личный процент уволенного не применяется — действует общее правило (как в зарплате)', () => {
    const dto = buildStaffMoney({
      user: user({ isActive: false, bonusPercent: 99 }),
      rule: rule({ pieceworkPercent: 30 }),
      earnings: null,
      payouts: [],
      sheets: [],
    });
    expect(dto.config.effectiveWorkPercent).toBe(30);
    expect(dto.config.hasPersonal).toBe(false);
  });

  it('история выплат и ведомостей у уволенного остаётся видимой', () => {
    const dto = buildStaffMoney({
      user: user({ isActive: false }),
      rule: rule(),
      earnings: null,
      payouts: [payout()],
      sheets: [sheet('2026-07', [entry()])],
    });
    expect(dto.payouts).toHaveLength(1);
    expect(dto.sheetRows).toHaveLength(1);
  });
});

describe('buildStaffMoney: условия оплаты', () => {
  it('личный оклад и процент активного применяются', () => {
    const dto = buildStaffMoney({
      user: user({ baseSalaryKopecks: 4_000_000n, bonusPercent: 15 }),
      rule: rule({ pieceworkPercent: 30 }),
      earnings: breakdown(),
      payouts: [],
      sheets: [],
    });
    expect(dto.config.hasPersonal).toBe(true);
    expect(dto.config.effectiveWorkPercent).toBe(15);
    expect(dto.config.personalBaseSalaryKopecks).toBe('4000000');
  });

  it('без личного правила действует общее; earnings null не превращается в цифры', () => {
    const dto = buildStaffMoney({
      user: user(),
      rule: rule({ mode: 'salary_bonus', baseSalaryKopecks: '4000000', bonusPercent: 10 }),
      earnings: null,
      payouts: [],
      sheets: [],
    });
    expect(dto.config.hasPersonal).toBe(false);
    expect(dto.config.effectiveWorkPercent).toBe(10);
    expect(dto.earnings).toBeNull();
  });
});

describe('buildStaffMoney: строки ведомостей', () => {
  it('чужие строки не попадают, своя видна с флагом проведения', () => {
    const dto = buildStaffMoney({
      user: user(),
      rule: rule(),
      earnings: null,
      payouts: [],
      sheets: [
        sheet('2026-07', [entry(), entry({ employeeId: 'other', employeeName: 'Чужой' })], {
          posted: true,
        }),
      ],
    });
    expect(dto.sheetRows).toHaveLength(1);
    expect(dto.sheetRows[0]!.month).toBe('2026-07');
    expect(dto.sheetRows[0]!.posted).toBe(true);
    expect(dto.sheetRows[0]!.salaryKopecks).toBe('4000000');
  });

  it('«к выплате» = max(0, начислено − аванс) по КАЖДОЙ строке — как при проведении в кассу', () => {
    // Первая строка: аванс 50 000 ₽ больше оклада 40 000 ₽ → к выплате 0 (долг, не скидка).
    // Вторая строка: оклад 10 000 ₽ без аванса → 10 000 ₽.
    // От суммы получилось бы max(0, 50 000 − 50 000) = 0 — формула обязана считать построчно.
    const dto = buildStaffMoney({
      user: user(),
      rule: rule(),
      earnings: null,
      payouts: [],
      sheets: [
        sheet('2026-07', [
          entry({ advanceKopecks: 5_000_000 }),
          entry({ salaryKopecks: 1_000_000 }),
        ]),
      ],
    });
    expect(dto.sheetRows).toHaveLength(1);
    expect(dto.sheetRows[0]!.toPayKopecks).toBe('1000000');
    // Компоненты при этом суммируются честно.
    expect(dto.sheetRows[0]!.salaryKopecks).toBe('5000000');
    expect(dto.sheetRows[0]!.advanceKopecks).toBe('5000000');
  });

  it('месяцы отсортированы свежие сверху', () => {
    const dto = buildStaffMoney({
      user: user(),
      rule: rule(),
      earnings: null,
      payouts: [],
      sheets: [sheet('2026-06', [entry()]), sheet('2026-08', [entry()])],
    });
    expect(dto.sheetRows.map((r) => r.month)).toEqual(['2026-08', '2026-06']);
  });
});

describe('buildStaffMoney: выплаты', () => {
  it('отсортированы по дате выплаты, свежие сверху', () => {
    const dto = buildStaffMoney({
      user: user(),
      rule: rule(),
      earnings: null,
      payouts: [payout({ paidOn: '2026-07-10' }), payout({ paidOn: '2026-08-10' })],
      sheets: [],
    });
    expect(dto.payouts.map((p) => p.paidOn)).toEqual(['2026-08-10', '2026-07-10']);
  });
});

/* ─────────────────── интеграция: роли, выплаты, ведомость ─────────────────── */

const TEST_PREFIX = 'TEST-STAFFMONEY-';
/** Месяц, которым не пользуется ни один другой тест ведомостей. */
const TEST_MONTH = '2031-03';

let erfolgId = '';
let engineerId = '';
let dispatcherId = '';
let directorId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const eng = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  const dir = usrs.find((u) => u.role === 'director');
  if (!eng || !disp || !dir) throw new Error('seed missing engineer/dispatcher/director');
  engineerId = eng.id;
  dispatcherId = disp.id;
  directorId = dir.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(payrollPayouts).where(like(payrollPayouts.comment, `${TEST_PREFIX}%`));
    await tx.delete(cashTransactions).where(like(cashTransactions.comment, `${TEST_PREFIX}%`));
    await tx.delete(cashAccounts).where(like(cashAccounts.name, `${TEST_PREFIX}%`));
    await tx.delete(payrollSheets).where(eq(payrollSheets.month, TEST_MONTH));
  });
});

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(role: 'director' | 'dispatcher' | 'engineer'): Context {
  const userId =
    role === 'director' ? directorId : role === 'dispatcher' ? dispatcherId : engineerId;
  const session: SessionData = {
    tenantId: erfolgId,
    userId,
    username: `${role}-test`,
    role,
    fullName: `Test ${role}`,
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: erfolgId,
      subdomain: 'erfolg',
      displayName: 'erfolg',
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    },
    session,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
  };
}

describe('payroll.staffMoney: доступ', () => {
  it('менеджеру (dispatcher) — отказ: деньги по людям только директору', async () => {
    const dispatcher = appRouter.createCaller(makeCtx('dispatcher'));
    await expect(
      dispatcher.payroll.staffMoney({ userId: engineerId, month: TEST_MONTH }),
    ).rejects.toThrow();
  });

  it('несуществующий сотрудник — NOT_FOUND', async () => {
    const director = appRouter.createCaller(makeCtx('director'));
    await expect(
      director.payroll.staffMoney({ userId: uuidv7(), month: TEST_MONTH }),
    ).rejects.toThrow(/не найден/i);
  });
});

describe('payroll.staffMoney: данные', () => {
  it('выплата, проведённая инженеру, видна в его истории', async () => {
    const acc = await createAccount(getDb(), erfolgId, {
      name: `${TEST_PREFIX}нал`,
      kind: 'cash',
      openingBalanceKopecks: 1_000_000n,
    });
    await createPayout(getDb(), erfolgId, {
      engineerId,
      kind: 'advance',
      periodStart: '2031-03-01',
      periodEnd: '2031-03-31',
      periodLabel: 'Месяц',
      computedKopecks: 42_000n,
      amountKopecks: 42_000n,
      paidOn: '2031-03-20',
      accountId: acc.id,
      comment: `${TEST_PREFIX}аванс`,
      createdBy: null,
    });

    const director = appRouter.createCaller(makeCtx('director'));
    const dto = await director.payroll.staffMoney({ userId: engineerId, month: TEST_MONTH });
    const mine = dto.payouts.find((p) => p.comment === `${TEST_PREFIX}аванс`);
    expect(mine).toBeTruthy();
    expect(mine!.kind).toBe('advance');
    expect(mine!.amountKopecks).toBe('42000');
  });

  it('строка ведомости человека видна, чужая — нет', async () => {
    const director = appRouter.createCaller(makeCtx('director'));
    await director.payroll.sheets.save({
      month: TEST_MONTH,
      entries: [
        {
          employeeId: engineerId,
          employeeName: 'Свой',
          salaryRub: 40_000,
          pieceworkRub: 0,
          advanceRub: 10_000,
          bonusRub: 0,
        },
        {
          employeeId: dispatcherId,
          employeeName: 'Чужой',
          salaryRub: 50_000,
          pieceworkRub: 0,
          advanceRub: 0,
          bonusRub: 0,
        },
      ],
    });

    const dto = await director.payroll.staffMoney({ userId: engineerId, month: TEST_MONTH });
    const row = dto.sheetRows.find((r) => r.month === TEST_MONTH);
    expect(row).toBeTruthy();
    expect(row!.salaryKopecks).toBe('4000000');
    expect(row!.advanceKopecks).toBe('1000000');
    expect(row!.toPayKopecks).toBe('3000000');
    // Чужой оклад (50 000 ₽) не подмешался.
    expect(row!.salaryKopecks).not.toBe('9000000');
  });
});
