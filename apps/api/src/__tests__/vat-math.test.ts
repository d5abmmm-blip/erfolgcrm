/**
 * Unit-тесты для calcVatInclusive из invoices/repository.ts.
 *
 * Эрфольг работает по специальному режиму НДС 5% (медтехника, лицензия Росздравнадзора
 * ФС-99-04). Других ставок: vat10, vat20, vat0, without_vat. Формула «вкладной»:
 *   vat = round(total * rate / (100 + rate))
 *
 * БД здесь не нужна — это чистая bigint-математика.
 */
import { describe, it, expect } from 'vitest';
import type { VatRate } from '@erfolg/shared';
import { calcVatInclusive } from '../modules/invoices/repository';

describe('calcVatInclusive — НДС 5% (специальный режим Эрфольг)', () => {
  it('1 050 000 коп с НДС 5% = 50 000 коп', () => {
    // 10500 руб с НДС → НДС = 10500 * 5 / 105 = 500 руб = 50 000 коп
    expect(calcVatInclusive(1_050_000n, '5')).toBe(50_000n);
  });

  it('1 234 567 коп с НДС 5% округление через bigint integer division', () => {
    // 1234567 * 5 = 6_172_835. (6_172_835 + 52) / 105 = 58_789 (integer div).
    // Истинное матем. значение: 58789.857… → ближайшее целое = 58_790.
    // ВНИМАНИЕ: формула в repository использует half = denom/2 = 52 (а не 52.5).
    // Поэтому она округляет «почти к ближайшему» — могут быть расхождения на ±1 коп
    // на больших суммах. Это потенциальная находка для бухгалтерии.
    expect(calcVatInclusive(1_234_567n, '5')).toBe(58_789n);
  });

  it('правило round-half-up: 21 коп с НДС 5%', () => {
    // 21 * 5 / 105 = 1.00 ровно
    expect(calcVatInclusive(21n, '5')).toBe(1n);
  });

  it('1 коп с НДС 5% не падает в отрицательное / NaN', () => {
    // 1 * 5 / 105 = 0.0476... → 0 копеек НДС (sub-копеечная сумма не порождает НДС)
    const result = calcVatInclusive(1n, '5');
    expect(result).toBeGreaterThanOrEqual(0n);
    expect(result).toBe(0n);
  });
});

describe('calcVatInclusive — стандартные ставки', () => {
  it('1 200 000 коп с НДС 20% = 200 000 коп', () => {
    // 12000 руб, НДС 20% = 12000 * 20 / 120 = 2000 руб
    expect(calcVatInclusive(1_200_000n, '20')).toBe(200_000n);
  });

  it('1 100 000 коп с НДС 10% = 100 000 коп', () => {
    expect(calcVatInclusive(1_100_000n, '10')).toBe(100_000n);
  });

  it('НДС 0% всегда возвращает 0n независимо от суммы', () => {
    expect(calcVatInclusive(1_000_000n, '0')).toBe(0n);
    expect(calcVatInclusive(0n, '0')).toBe(0n);
    expect(calcVatInclusive(9_999_999_999n, '0')).toBe(0n);
  });

  it('without_vat всегда возвращает 0n', () => {
    expect(calcVatInclusive(1_000_000n, 'without_vat')).toBe(0n);
    expect(calcVatInclusive(123_456_789n, 'without_vat')).toBe(0n);
  });
});

describe('calcVatInclusive — edge-кейсы', () => {
  it('сумма 0 → 0', () => {
    expect(calcVatInclusive(0n, '5')).toBe(0n);
    expect(calcVatInclusive(0n, '20')).toBe(0n);
    expect(calcVatInclusive(0n, '10')).toBe(0n);
  });

  it('очень большая сумма (≈триллион копеек) не overflow', () => {
    // bigint не имеет верхнего предела — просто sanity-check без NaN/Infinity
    const huge = 9_999_999_999_999n;
    const vat = calcVatInclusive(huge, '5');
    // 9_999_999_999_999 * 5 = 49_999_999_999_995. (49_999_999_999_995 + 52) / 105 = 476_190_476_190.
    expect(vat).toBe(476_190_476_190n);
    expect(typeof vat).toBe('bigint');
    // Sanity: vat * (1 + 100/rate) ≈ total (округление в пределах 1 копейки)
    expect(vat * 21n).toBeLessThanOrEqual(huge);
  });

  it('НДС всегда ≤ totalKopecks для всех ставок', () => {
    const cases: Array<[bigint, VatRate]> = [
      [100_000n, '5'],
      [100_000n, '10'],
      [100_000n, '20'],
      [1n, '20'],
      [123_456_789n, '5'],
      [987_654_321n, '10'],
    ];
    for (const [total, rate] of cases) {
      const vat = calcVatInclusive(total, rate);
      expect(vat).toBeLessThanOrEqual(total);
      expect(vat).toBeGreaterThanOrEqual(0n);
    }
  });

  it('property-based: для случайных сумм НДС всегда в [0, total]', () => {
    const rates: VatRate[] = ['0', '5', '10', '20', 'without_vat'];
    // Псевдо-случайный генератор без зависимостей: LCG.
    let seed = 0xc0ffee;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 200; i += 1) {
      const total = BigInt(next() % 1_000_000_000); // до 10 млн ₽
      const rate = rates[next() % rates.length] as VatRate;
      const vat = calcVatInclusive(total, rate);
      expect(vat).toBeGreaterThanOrEqual(0n);
      expect(vat).toBeLessThanOrEqual(total);
      if (rate === '0' || rate === 'without_vat') {
        expect(vat).toBe(0n);
      }
    }
  });

  it('расчёт коммутативен: повторный вызов даёт тот же результат', () => {
    const a = calcVatInclusive(7_654_321n, '5');
    const b = calcVatInclusive(7_654_321n, '5');
    expect(a).toBe(b);
  });
});
