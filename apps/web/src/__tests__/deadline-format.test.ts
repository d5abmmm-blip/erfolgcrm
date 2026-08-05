/**
 * Срок в мобильной очереди. Баг с фото инженера: «просрочено на 196 ч» —
 * просрочка показывалась только в часах, сколько бы их ни набежало.
 */
import { describe, expect, it } from 'vitest';
import { fmtDeadline } from '../lib/deadline';

const NOW = new Date('2026-08-05T12:00:00Z').getTime();
const hoursFromNow = (h: number) => new Date(NOW + h * 3_600_000);

describe('fmtDeadline', () => {
  it('пустой срок — пустая строка', () => {
    expect(fmtDeadline(null, NOW)).toBe('');
  });

  it('свежая просрочка — в часах', () => {
    expect(fmtDeadline(hoursFromNow(-3), NOW)).toBe('просрочено на 3 ч');
    expect(fmtDeadline(hoursFromNow(-47), NOW)).toBe('просрочено на 47 ч');
  });

  it('просрочка от двух суток — в днях («196 ч» с фото инженера = 8 дн)', () => {
    expect(fmtDeadline(hoursFromNow(-196), NOW)).toBe('просрочено на 8 дн');
    expect(fmtDeadline(hoursFromNow(-48), NOW)).toBe('просрочено на 2 дн');
  });

  it('будущий срок: до суток — часы, дальше — дни (как было)', () => {
    expect(fmtDeadline(hoursFromNow(5), NOW)).toBe('осталось 5 ч');
    expect(fmtDeadline(hoursFromNow(72), NOW)).toBe('осталось 3 дн');
  });

  it('принимает и строку ISO', () => {
    expect(fmtDeadline(hoursFromNow(-196).toISOString(), NOW)).toBe('просрочено на 8 дн');
  });
});
