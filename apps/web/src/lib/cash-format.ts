/** Утилиты форматирования/парсинга для кассы (ДДС). */

const MONTH_SHORT = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

/** 'YYYY-MM' → короткое русское название месяца ('2026-06' → 'июн'). */
export function monthLabel(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return MONTH_SHORT[m - 1] ?? ym;
}

/**
 * Парсит пользовательский ввод суммы в рублях ('1 234,56' / '1234.5' / '500').
 * Возвращает число рублей или null, если ввод пустой/некорректный/не положительный.
 * Для операций кассы сумма всегда строго больше нуля.
 */
export function parsePositiveRub(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
