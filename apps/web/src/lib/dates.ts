/**
 * Форматирование дат и дневная арифметика для мобильных экранов.
 * Раньше эти хелперы были рассыпаны копиями по страницам (/m/queue, /m/tickets,
 * /m/tasks) — здесь одно определение на всех.
 */

function toDate(d: Date | string): Date {
  return typeof d === 'string' ? new Date(d) : d;
}

/** «14:05» */
export function fmtTime(d: Date | string): string {
  return toDate(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** «05.08, 14:05» — компактная отметка времени для карточек и истории. */
export function fmtShortDateTime(d: Date | string): string {
  return toDate(d).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «5 августа, 14:00 – 15:30» (или без конца, если он не задан) — окно выезда. */
export function fmtScheduleSlot(start: Date | string, end: Date | string | null): string {
  const s = toDate(start);
  const dayLabel = s.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const startTime = fmtTime(s);
  if (!end) return `${dayLabel}, ${startTime}`;
  return `${dayLabel}, ${startTime} – ${fmtTime(end)}`;
}

/** Срок задачи: «05.08 · 14:00», «05.08» или «без даты». */
export function fmtDue(dueDate: string | null, dueTime: string | null): string {
  if (!dueDate) return 'без даты';
  const [, m, d] = dueDate.split('-');
  return dueTime ? `${d}.${m} · ${dueTime}` : `${d}.${m}`;
}

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

/** Попадание в полуинтервал [start, end) — «этот календарный день». */
export function inDayRange(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}
