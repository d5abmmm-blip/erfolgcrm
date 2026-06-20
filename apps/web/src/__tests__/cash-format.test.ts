import { describe, it, expect } from 'vitest';
import { monthLabel, parsePositiveRub } from '../lib/cash-format';

describe('monthLabel', () => {
  it('переводит YYYY-MM в короткий месяц', () => {
    expect(monthLabel('2026-01')).toBe('янв');
    expect(monthLabel('2026-06')).toBe('июн');
    expect(monthLabel('2026-12')).toBe('дек');
  });
  it('возвращает исходную строку при некорректном вводе', () => {
    expect(monthLabel('2026-13')).toBe('2026-13');
  });
});

describe('parsePositiveRub', () => {
  it('парсит целые и дробные суммы', () => {
    expect(parsePositiveRub('500')).toBe(500);
    expect(parsePositiveRub('1234.5')).toBe(1234.5);
  });
  it('принимает запятую и пробелы-разделители', () => {
    expect(parsePositiveRub('1 234,56')).toBe(1234.56);
  });
  it('отклоняет пустое, ноль, отрицательное и мусор', () => {
    expect(parsePositiveRub('')).toBeNull();
    expect(parsePositiveRub('0')).toBeNull();
    expect(parsePositiveRub('-5')).toBeNull();
    expect(parsePositiveRub('abc')).toBeNull();
  });
});
