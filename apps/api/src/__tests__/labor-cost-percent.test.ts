/**
 * Себестоимость труда = процент инженера от суммы работ.
 *
 * ПОЧЕМУ НЕ ЧАСЫ: на бою все 2224 строки работ заведены в «шт», а не в «час»
 * (проверено запросом к боевой базе 2026-07-24). Часовая ставка умножалась бы
 * на «1 шт», то есть замена предохранителя и капремонт стоили бы одинаково.
 * Процент же привязан к конкретной работе точно — это ровно те деньги, которые
 * инженер получит за неё по схеме «оклад + % от работ».
 *
 * ГЛАВНОЕ ТРЕБОВАНИЕ: определение процента ОДНО на всю систему. Им пользуются
 * и расчёт зарплаты (computeRow), и себестоимость строки наряда (resolveLineCost).
 * Разойдутся — себестоимость перестанет сходиться с выплатой.
 *
 * Тесты ЧИСТЫЕ (без базы) намеренно: payroll.test.ts в beforeEach делает
 * `DELETE FROM engineer_payout_rules` и обнуляет payout_* У ВСЕХ пользователей,
 * а vitest гоняет файлы параллельно — интеграционный тест на тех же полях мигал бы.
 */
import { describe, it, expect } from 'vitest';
import {
  laborCostPerUnitKopecks,
  resolveWorkPercent,
  type PayrollRule,
  type UserPayoutConfig,
} from '../modules/payroll/repository';

function rule(over: Partial<PayrollRule> = {}): PayrollRule {
  return {
    tenantId: '00000000-0000-0000-0000-000000000000',
    mode: 'salary_bonus',
    pieceworkPercent: 30,
    baseSalaryKopecks: '4000000',
    bonusPercent: 15,
    engineersSeeEarnings: true,
    updatedAt: new Date(0),
    ...over,
  };
}

function cfg(over: Partial<UserPayoutConfig> = {}): UserPayoutConfig {
  return {
    userId: '11111111-1111-1111-1111-111111111111',
    fullName: 'Инженер И.И.',
    isActive: true,
    baseSalaryKopecks: 4_000_000n,
    bonusPercent: 15,
    ...over,
  };
}

describe('resolveWorkPercent — какой процент платим за работу', () => {
  it('личное правило сотрудника важнее общего', () => {
    // у сотрудника личные 20 %, в общем правиле 15 % — берём личные
    expect(resolveWorkPercent(rule({ bonusPercent: 15 }), cfg({ bonusPercent: 20 }))).toBe(20);
  });

  it('задан только личный оклад, процент не задан → процент 0', () => {
    // ДЕНЬГИ: так же считает зарплата (cfg.bonusPercent ?? 0). Расхождение здесь
    // означало бы, что себестоимость есть, а выплаты за работы нет.
    expect(resolveWorkPercent(rule(), cfg({ bonusPercent: null }))).toBe(0);
  });

  it('задан только личный процент, оклада нет → берём личный процент', () => {
    expect(resolveWorkPercent(rule({ bonusPercent: 15 }), cfg({ baseSalaryKopecks: null, bonusPercent: 25 }))).toBe(25);
  });

  it('личного правила нет, общий режим «оклад + бонус» → бонусный процент', () => {
    expect(resolveWorkPercent(rule({ mode: 'salary_bonus', bonusPercent: 15, pieceworkPercent: 30 }), undefined)).toBe(15);
  });

  it('личного правила нет, общий режим «сделка» → сдельный процент', () => {
    expect(resolveWorkPercent(rule({ mode: 'piecework', bonusPercent: 15, pieceworkPercent: 30 }), undefined)).toBe(30);
  });

  it('оба поля личного правила пустые → это НЕ личное правило, берём общее', () => {
    expect(
      resolveWorkPercent(rule({ bonusPercent: 15 }), cfg({ baseSalaryKopecks: null, bonusPercent: null })),
    ).toBe(15);
  });

  it('уволенный сотрудник считается по ОБЩЕМУ правилу, личное не применяется', () => {
    // Зарплата грузит личные настройки только у активных (loadUserPayoutConfigs:
    // AND is_active = true). Себестоимость обязана вести себя так же.
    expect(
      resolveWorkPercent(rule({ mode: 'piecework', pieceworkPercent: 30 }), cfg({ isActive: false, bonusPercent: 99 })),
    ).toBe(30);
  });
});

describe('laborCostPerUnitKopecks — себестоимость единицы работы', () => {
  it('15 % от 10 000 коп = 1 500 коп', () => {
    expect(laborCostPerUnitKopecks(10_000n, 15)).toBe(1_500n);
  });

  it('процент 0 → себестоимость 0', () => {
    expect(laborCostPerUnitKopecks(10_000n, 0)).toBe(0n);
  });

  it('нулевая цена → 0', () => {
    expect(laborCostPerUnitKopecks(0n, 15)).toBe(0n);
  });

  it('дробь усекается вниз, как и в зарплате (333 × 15 % = 49, не 50)', () => {
    expect(laborCostPerUnitKopecks(333n, 15)).toBe(49n);
  });

  it('отрицательный процент невозможен, но не роняет расчёт', () => {
    expect(laborCostPerUnitKopecks(10_000n, -5)).toBe(0n);
  });

  it('100 % → себестоимость равна цене (маржа по строке 0)', () => {
    expect(laborCostPerUnitKopecks(10_000n, 100)).toBe(10_000n);
  });
});

describe('ДЕНЬГИ: себестоимость строки не расходится с тем, что заплатят инженеру', () => {
  // Зарплата берёт процент от ВСЕЙ суммы работ, а себестоимость хранится на ЕДИНИЦУ
  // и умножается на количество. Из-за усечения расхождение возможно, но оно
  // обязано быть меньше копейки на каждую единицу — иначе маржа поедет.
  const cases: Array<{ unit: bigint; qty: bigint; percent: number }> = [
    { unit: 333n, qty: 3n, percent: 15 },
    { unit: 99_999n, qty: 7n, percent: 15 },
    { unit: 1n, qty: 1000n, percent: 30 },
    { unit: 250_000n, qty: 2n, percent: 20 },
  ];

  for (const c of cases) {
    it(`цена ${c.unit} × ${c.qty} шт под ${c.percent} %`, () => {
      const costTotal = laborCostPerUnitKopecks(c.unit, c.percent) * c.qty;
      const payrollTotal = (c.unit * c.qty * BigInt(c.percent)) / 100n;
      const diff = payrollTotal > costTotal ? payrollTotal - costTotal : costTotal - payrollTotal;
      expect(diff).toBeLessThan(c.qty);
      // Себестоимость никогда не БОЛЬШЕ того, что реально заплатят.
      expect(costTotal).toBeLessThanOrEqual(payrollTotal);
    });
  }
});
