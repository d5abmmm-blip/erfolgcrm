import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value);
}

// Реэкспорт денежных хелперов из единого источника, чтобы старые импорты не сломались.
export { formatRub, formatRubWhole, kopecksToRub, kopecksToRubInput } from './money';

/**
 * Понедельник текущей недели в локальном timezone, время 00:00:00.
 * Используется для запроса tickets.myWeeklySchedule / tickets.weeklySchedule.
 */
export function getMondayOfThisWeek(): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}
