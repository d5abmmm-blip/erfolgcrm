/**
 * PR-5 «Касса: сравнение с прошлым периодом».
 *
 * Проверяем расчёт предыдущего сопоставимого окна. Главная ловушка — календарные границы:
 * «месяц к месяцу» должен сравнивать 1–15 июля с 1–15 ИЮНЯ (а не с равным куском, который
 * перетекает через границу месяца), и не должен выходить за короткий февраль.
 *
 * Чистая функция, без БД.
 */
import { describe, it, expect } from 'vitest';
import { resolvePreviousPeriod } from '../modules/cash/service';

const d = (iso: string) => new Date(iso);
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe('resolvePreviousPeriod', () => {
  it('сегодня → вчера', () => {
    const prev = resolvePreviousPeriod('today', {
      start: d('2026-07-15T00:00:00Z'),
      end: d('2026-07-16T00:00:00Z'),
    });
    expect(iso(prev.start)).toBe('2026-07-14');
    expect(iso(prev.end)).toBe('2026-07-15');
  });

  it('неделя → предыдущие 7 дней', () => {
    const prev = resolvePreviousPeriod('week', {
      start: d('2026-07-09T00:00:00Z'),
      end: d('2026-07-16T00:00:00Z'),
    });
    expect(iso(prev.start)).toBe('2026-07-02');
    expect(iso(prev.end)).toBe('2026-07-09');
  });

  it('месяц → ТОТ ЖЕ отрезок прошлого месяца (1–15 июля ↔ 1–15 июня)', () => {
    const prev = resolvePreviousPeriod('month', {
      start: d('2026-07-01T00:00:00Z'),
      end: d('2026-07-16T00:00:00Z'), // 15 дней месяца прошло
    });
    expect(iso(prev.start)).toBe('2026-06-01');
    expect(iso(prev.end)).toBe('2026-06-16'); // 1–15 июня, а не 16–30 июня
  });

  it('месяц: 31 марта не обрезается в несуществующее 31 февраля — берём февраль целиком', () => {
    const prev = resolvePreviousPeriod('month', {
      start: d('2026-03-01T00:00:00Z'),
      end: d('2026-04-01T00:00:00Z'), // весь март, 31 день
    });
    expect(iso(prev.start)).toBe('2026-02-01');
    expect(iso(prev.end)).toBe('2026-03-01'); // весь февраль (28 дней), без перелёта в март
  });

  it('квартал → тот же отрезок прошлого квартала', () => {
    const prev = resolvePreviousPeriod('quarter', {
      start: d('2026-07-01T00:00:00Z'), // начало Q3
      end: d('2026-07-16T00:00:00Z'),
    });
    expect(iso(prev.start)).toBe('2026-04-01'); // начало Q2
    expect(iso(prev.end)).toBe('2026-04-16');
  });

  it('год → тот же отрезок прошлого года', () => {
    const prev = resolvePreviousPeriod('year', {
      start: d('2026-01-01T00:00:00Z'),
      end: d('2026-01-16T00:00:00Z'),
    });
    expect(iso(prev.start)).toBe('2025-01-01');
    expect(iso(prev.end)).toBe('2025-01-16');
  });

  it('предыдущее окно не длиннее текущего (сравниваем сопоставимое)', () => {
    const current = { start: d('2026-07-01T00:00:00Z'), end: d('2026-07-16T00:00:00Z') };
    const prev = resolvePreviousPeriod('month', current);
    const len = (p: { start: Date; end: Date }) => p.end.getTime() - p.start.getTime();
    expect(len(prev)).toBeLessThanOrEqual(len(current));
  });
});
