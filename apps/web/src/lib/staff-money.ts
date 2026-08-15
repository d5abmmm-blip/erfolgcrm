/**
 * Вкладка «Деньги» на карточке сотрудника: месяцы переключателя и подписи.
 *
 * Период здесь ТОЛЬКО помесячный — не «месяц/3 месяца/всё время», как на вкладке
 * «Работа». Оклад месячный и в расчёте прибавляется один раз (см. комментарий у
 * payroll/repository.computeRow), поэтому «заработано за всё время» показало бы
 * оклад однократно и врало бы в деньгах. Список месяцев начинается с запуска CRM
 * (statsSince) — раньше данных о людях нет.
 */

const PAYOUT_KIND_RU: Record<string, string> = {
  advance: 'аванс',
  final: 'окончательный расчёт',
  bonus: 'премия',
};

/** Тип выплаты по-русски; незнакомый тип возвращаем как есть, а не прячем. */
export function payoutKindRu(kind: string): string {
  return PAYOUT_KIND_RU[kind] ?? kind;
}

const MONTHS_RU_FULL = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

/** «2026-08» → «август 2026»; непонятный ключ возвращаем как есть. */
export function monthTitleRu(ym: string): string {
  const [y, m] = ym.split('-');
  const name = MONTHS_RU_FULL[Number(m) - 1];
  return name && y ? `${name} ${y}` : ym;
}

/**
 * Месяцы для переключателя: от текущего назад до месяца запуска CRM, свежие
 * сверху. Считаем в UTC — так же, как сервер строит границы месяца.
 */
export function monthOptions(now: Date, statsSince: Date): string[] {
  const list: string[] = [];
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  const sinceY = statsSince.getUTCFullYear();
  const sinceM = statsSince.getUTCMonth();
  while (y > sinceY || (y === sinceY && m >= sinceM)) {
    list.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  // Сбитые часы (сегодня «раньше» запуска CRM) не должны оставить пустой переключатель.
  if (list.length === 0) {
    list.push(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return list;
}
