/**
 * Вкладка «Деньги»: месяцы переключателя и подписи.
 *
 * Период здесь ТОЛЬКО помесячный — не «месяц/3 месяца/всё время», как на «Работе».
 * Оклад месячный и прибавляется один раз (payroll/repository.computeRow), поэтому
 * «заработано за всё время» показывало бы оклад однократно и врало бы в деньгах.
 * Список месяцев начинается с запуска CRM (statsSince) — раньше данных о людях нет.
 */
import { describe, it, expect } from 'vitest';
import { monthOptions, monthTitleRu, payoutKindRu } from '../lib/staff-money';

describe('monthOptions', () => {
  it('от текущего месяца назад до месяца запуска CRM, свежие сверху', () => {
    expect(
      monthOptions(new Date('2026-08-15T12:00:00Z'), new Date('2026-07-05T00:00:00Z')),
    ).toEqual(['2026-08', '2026-07']);
  });

  it('в первый месяц работы — один пункт', () => {
    expect(
      monthOptions(new Date('2026-07-20T12:00:00Z'), new Date('2026-07-05T00:00:00Z')),
    ).toEqual(['2026-07']);
  });

  it('переваливает через границу года', () => {
    expect(
      monthOptions(new Date('2027-01-10T12:00:00Z'), new Date('2026-11-05T00:00:00Z')),
    ).toEqual(['2027-01', '2026-12', '2026-11']);
  });
});

describe('monthTitleRu', () => {
  it('пишет месяц словом', () => {
    expect(monthTitleRu('2026-08')).toBe('август 2026');
    expect(monthTitleRu('2026-01')).toBe('январь 2026');
  });

  it('непонятный ключ возвращает как есть, а не «undefined 2026»', () => {
    expect(monthTitleRu('2026-13')).toBe('2026-13');
  });
});

describe('payoutKindRu', () => {
  it('типы выплат по-русски', () => {
    expect(payoutKindRu('advance')).toBe('аванс');
    expect(payoutKindRu('final')).toBe('окончательный расчёт');
    expect(payoutKindRu('bonus')).toBe('премия');
  });
});
