/**
 * Вкладка «Работа» на карточке сотрудника: границы периода и подписи.
 *
 * Период — ПОЛУИНТЕРВАЛ [from, to): последний день месяца входит, первый день
 * следующего нет. Иначе закрытая 31-го числа заявка тихо пропадает из отчёта человека,
 * и заметно это станет только через месяц.
 *
 * Переключатель короткий сознательно: месяц, три месяца, всё время. «Полгода» и «год»
 * на наших данных дали бы те же самые цифры (своё в CRM только с 9 июля 2026) и
 * создали бы ложное впечатление годовой истории.
 */
import { pluralRu } from './staff';
import { formatDateRu } from './staff-hr';

export type WorkPeriodKind = 'month' | 'quarter' | 'all';

export const WORK_PERIOD_LABELS: Record<WorkPeriodKind, string> = {
  month: 'Месяц',
  quarter: '3 месяца',
  all: 'Всё время',
};

/** Границы выбранного периода. Считаем в UTC — сервер сравнивает моменты времени. */
export function workPeriod(
  kind: WorkPeriodKind,
  now: Date,
  statsSince: Date,
): { from: Date; to: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const nextMonthStart = new Date(Date.UTC(year, month + 1, 1));

  if (kind === 'month') {
    return { from: new Date(Date.UTC(year, month, 1)), to: nextMonthStart };
  }
  if (kind === 'quarter') {
    return { from: new Date(Date.UTC(year, month - 2, 1)), to: nextMonthStart };
  }
  // «Всё время» начинается с запуска CRM: раньше данных о людях просто нет.
  // Верхняя граница — завтра, чтобы сегодняшние закрытия точно попали.
  const tomorrow = new Date(now.getTime());
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return { from: statsSince, to: tomorrow };
}

/** «2026-08-03» → «3 авг» — подпись столбика недели. */
export function weekLabel(weekStartIso: string): string {
  const full = formatDateRu(weekStartIso);
  // Год в подписи столбика лишний: период и так виден переключателем.
  return full.split(' ').slice(0, 2).join(' ');
}

/**
 * Среднее время закрытия. Прочерк вместо нуля: «0 дней» читалось бы как «закрывает
 * мгновенно», хотя на деле закрытых заявок просто нет.
 */
export function avgDaysPhrase(days: number | null): string {
  if (days === null) return '—';
  const rounded = Math.round(days * 10) / 10;
  const isWhole = Number.isInteger(rounded);
  const word = isWhole ? pluralRu(rounded, 'день', 'дня', 'дней') : 'дня';
  return `${String(rounded).replace('.', ',')} ${word}`;
}

/** «3 заявки закрыты» — согласовано по числу; ноль говорим словами. */
export function closedPhrase(n: number): string {
  if (n === 0) return 'ничего не закрыто';
  const noun = pluralRu(n, 'заявка', 'заявки', 'заявок');
  const verb = pluralRu(n, 'закрыта', 'закрыты', 'закрыто');
  return `${n} ${noun} ${verb}`;
}
