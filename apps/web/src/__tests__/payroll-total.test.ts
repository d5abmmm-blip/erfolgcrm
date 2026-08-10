import { describe, it, expect } from 'vitest';
import { vedomostNetTotal, vedomostPayoutTotal } from '../lib/payroll-total';

describe('vedomostNetTotal — итог зарплатной ведомости', () => {
  it('аванс вычитается из начисленного, а не прибавляется', () => {
    // Оклад 40000 + сделка 20000 + премия 5000 = 65000 начислено.
    // Аванс 20000 уже выдан → остаток к доплате = 45000.
    expect(vedomostNetTotal({ salary: 40000, piecework: 20000, bonus: 5000, advance: 20000 })).toBe(
      45000,
    );
  });

  it('без аванса итог равен начисленному', () => {
    expect(vedomostNetTotal({ salary: 40000, piecework: 20000, bonus: 5000, advance: 0 })).toBe(
      65000,
    );
  });

  it('аванс больше начисленного → отрицательный остаток (переплата)', () => {
    expect(vedomostNetTotal({ salary: 10000, piecework: 0, bonus: 0, advance: 15000 })).toBe(-5000);
  });
});

describe('vedomostPayoutTotal — сколько денег уходит по ведомости', () => {
  it('долг переавансированного не уменьшает выплату остальным', () => {
    expect(
      vedomostPayoutTotal([
        { salary: 20000, piecework: 0, bonus: 0, advance: 0 },
        // Начислено 10000, аванс 15000 → долг 5000, к выплате 0.
        { salary: 10000, piecework: 0, bonus: 0, advance: 15000 },
      ]),
    ).toBe(20000);
  });

  it('без переплат совпадает с суммой остатков', () => {
    expect(
      vedomostPayoutTotal([
        { salary: 40000, piecework: 20000, bonus: 5000, advance: 20000 },
        { salary: 30000, piecework: 0, bonus: 0, advance: 10000 },
      ]),
    ).toBe(45000 + 20000);
  });

  it('пустая ведомость — ноль', () => {
    expect(vedomostPayoutTotal([])).toBe(0);
  });
});
