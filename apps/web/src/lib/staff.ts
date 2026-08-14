/**
 * Раздел «Сотрудники»: подписи и мелкие чистые функции.
 *
 * Держим отдельно от компонентов, чтобы список и карточка называли вещи одинаково,
 * а тексты можно было проверить тестом без отрисовки.
 */

export type StaffRole = 'director' | 'dispatcher' | 'engineer';
export type AwayKind = 'day_off' | 'vacation' | 'onsite';

export const ROLE_LABELS_RU: Record<StaffRole, string> = {
  director: 'Директор',
  dispatcher: 'Менеджер',
  engineer: 'Инженер',
};

export const AWAY_LABELS: Record<AwayKind, string> = {
  day_off: 'Выходной',
  vacation: 'Отпуск',
  onsite: 'На выезде',
};

/** «3 заявки» / «1 заявка» / «5 заявок» — русские окончания по числу. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function ticketsWord(n: number): string {
  return pluralRu(n, 'заявка', 'заявки', 'заявок');
}

/**
 * «1 незакрытая заявка» / «2 незакрытые заявки» / «5 незакрытых заявок».
 * Прилагательное склоняется вместе с существительным — иначе на экране появляется
 * «Ещё 1 незакрытых заявок», что и вышло при первой живой проверке.
 */
export function openTicketsPhrase(n: number): string {
  const adj = pluralRu(n, 'незакрытая', 'незакрытые', 'незакрытых');
  return `${n} ${adj} ${ticketsWord(n)}`;
}

/** Подпись под списком: сколько человек сегодня отсутствует. */
export function awayText(count: number): string {
  if (count === 0) return 'Сегодня отсутствующих нет.';
  const word = pluralRu(count, 'сотрудник', 'сотрудника', 'сотрудников');
  const verb = pluralRu(count, 'отсутствует', 'отсутствуют', 'отсутствуют');
  return `Сегодня ${verb} ${count} ${word}.`;
}

/**
 * Насколько человек загружен относительно остальных. Намеренно НЕ проценты и не
 * рейтинг: на нынешних объёмах (десятки заявок на всю компанию) процент от одного
 * закрытого дела даёт «100 %» и делает случайного человека лучшим в компании.
 * Три грубые ступени честнее точной цифры, которой нет.
 */
export function loadLevel(open: number): 'свободен' | 'умеренно' | 'загружен' {
  if (open === 0) return 'свободен';
  if (open <= 3) return 'умеренно';
  return 'загружен';
}

const RU_STATUS: Record<string, string> = {
  received: 'Принята',
  diagnostics: 'Диагностика',
  in_progress: 'В работе',
  act_pending: 'Ждёт акта',
  closed: 'Закрыта',
  cancelled: 'Отменена',
};

export function ticketStatusRu(status: string): string {
  return RU_STATUS[status] ?? status;
}

/** «до 20 авг» для интервала отсутствия. Даты приходят как YYYY-MM-DD, без времени. */
export function formatAwayRange(dateFrom: string, dateTo: string): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  return dateFrom === dateTo ? fmt(dateFrom) : `${fmt(dateFrom)} — ${fmt(dateTo)}`;
}
