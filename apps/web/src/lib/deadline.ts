/**
 * Срок по заявке в мобильной очереди инженера.
 *
 * До правки просрочка показывалась только в часах — на телефоне инженера
 * висело «просрочено на 196 ч», что читается как шум. Теперь от двух суток
 * переходим на дни. Будущий срок оставлен как был: до суток — часы, дальше дни.
 */
export function fmtDeadline(d: Date | string | null, now: number = Date.now()): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  const diffH = Math.round((date.getTime() - now) / 3_600_000);
  if (diffH < 0) {
    const h = Math.abs(diffH);
    if (h < 48) return `просрочено на ${h} ч`;
    return `просрочено на ${Math.round(h / 24)} дн`;
  }
  if (diffH < 24) return `осталось ${diffH} ч`;
  return `осталось ${Math.round(diffH / 24)} дн`;
}

/**
 * Срок из поля «дата» формы (`type="date"` отдаёт «2026-08-20») в момент времени.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ. Форма делала `new Date('2026-08-20')`, а такая строка по
 * стандарту читается как ПОЛНОЧЬ UTC — то есть 03:00 по Грозному. Просрочка же
 * считается как `deadline_at < now()`, поэтому заявка со сроком «сегодня»
 * становилась просроченной в три часа ночи: обещанный клиенту день терялся целиком.
 *
 * Срок — это «до конца дня», поэтому берём последнюю секунду выбранной даты по
 * МЕСТНОМУ времени (числовой конструктор Date, без разбора строки — он однозначен).
 * Все, кто заводит заявки, сидят в одном городе с сервисом.
 */
export function deadlineInputToDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
}

/**
 * Просрочена ли заявка — для красной подписи в списке.
 *
 * Отменённые и закрытые не считаем: на вкладке «Все» отменённая заявка
 * светилась «просрочено», хотя по ней уже ничего не сделать и делать не надо.
 * Раньше исключался только `closed`.
 */
export function isTicketOverdue(
  status: string,
  deadlineAt: Date | string | null,
  now: number = Date.now(),
): boolean {
  if (!deadlineAt) return false;
  if (status === 'closed' || status === 'cancelled') return false;
  const date = typeof deadlineAt === 'string' ? new Date(deadlineAt) : deadlineAt;
  return date.getTime() < now;
}
