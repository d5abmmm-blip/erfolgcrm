/**
 * Даты для человека: «30.08.2026», а не «2026-08-30».
 *
 * ЗАЧЕМ. В кабинете клиента даты счетов и договоров печатались сырым ISO прямо из
 * базы, а в списке заявок — по-русски. На одном экране клиент видел «2026-08-30»,
 * на соседнем «30.08.2026» и не мог сходу понять, где день, а где месяц.
 *
 * Пустое значение даёт «—», а неразобранное возвращается как есть: показать
 * непонятную строку честнее, чем «Invalid Date».
 */
export function formatDateRu(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('ru-RU');
}
