import { describe, it, expect } from 'vitest';
import { vedomostNetTotal } from '../lib/payroll-total';

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
