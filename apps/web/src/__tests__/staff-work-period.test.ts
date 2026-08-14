/**
 * Вкладка «Работа»: границы периода и подписи.
 *
 * Период — полуинтервал: последний день месяца обязан входить, первый день следующего
 * — нет. Ошибка здесь незаметна ровно до 31-го числа, когда закрытая заявка тихо
 * пропадает из отчёта человека.
 *
 * Переключатель нарочно короткий — месяц, три месяца, всё время. Полгода и год не
 * делаем: своих данных в CRM с 9 июля 2026, и «за год» показало бы те же цифры,
 * создав ложное впечатление годовой истории.
 */
import { describe, it, expect } from 'vitest';
import { avgDaysPhrase, closedPhrase, workPeriod, weekLabel } from '../lib/staff-work';

const NOW = new Date('2026-08-15T12:00:00Z');
const SINCE = new Date('2026-07-05T00:00:00Z');

describe('границы периода', () => {
  it('месяц — с первого числа по первое следующего', () => {
    const p = workPeriod('month', NOW, SINCE);
    expect(p.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('три месяца — включая текущий', () => {
    const p = workPeriod('quarter', NOW, SINCE);
    expect(p.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('всё время начинается с запуска CRM, а не с сотворения мира', () => {
    const p = workPeriod('all', NOW, SINCE);
    expect(p.from.toISOString()).toBe(SINCE.toISOString());
    expect(p.to.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('декабрь не перескакивает через год', () => {
    const p = workPeriod('month', new Date('2026-12-20T00:00:00Z'), SINCE);
    expect(p.from.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(p.to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('три месяца в январе уходят в прошлый год', () => {
    const p = workPeriod('quarter', new Date('2027-01-10T00:00:00Z'), SINCE);
    expect(p.from.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(p.to.toISOString()).toBe('2027-02-01T00:00:00.000Z');
  });
});

describe('подписи', () => {
  it('неделя подписана числом и месяцем', () => {
    expect(weekLabel('2026-08-03')).toBe('3 авг');
  });

  it('среднее время закрытия — с запятой, а не точкой', () => {
    expect(avgDaysPhrase(3.5)).toBe('3,5 дня');
    expect(avgDaysPhrase(1)).toBe('1 день');
    expect(avgDaysPhrase(11)).toBe('11 дней');
  });

  it('нет закрытых — прочерк, а не «0 дней»', () => {
    expect(avgDaysPhrase(null)).toBe('—');
  });

  it('счёт закрытых согласован по числу', () => {
    expect(closedPhrase(1)).toBe('1 заявка закрыта');
    expect(closedPhrase(3)).toBe('3 заявки закрыты');
    expect(closedPhrase(11)).toBe('11 заявок закрыто');
    expect(closedPhrase(0)).toBe('ничего не закрыто');
  });
});
