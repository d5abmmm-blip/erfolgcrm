/**
 * Частые типы/категории медтехники — стартовые подсказки для поля «Тип оборудования».
 * К ним в форме добавляются уже введённые значения из БД (assets.deviceTypes).
 * Свободный ввод — список не ограничивает, можно вписать любой свой тип.
 */
export const COMMON_DEVICE_TYPES = [
  'УЗИ-аппарат',
  'Рентген-аппарат',
  'Отсасыватель (аспиратор)',
  'Автоклав (стерилизатор)',
  'ЭКГ',
  'Аппарат ИВЛ',
  'Дефибриллятор',
  'Монитор пациента',
  'Наркозно-дыхательный аппарат',
  'Инфузомат',
  'Центрифуга',
  'Лабораторный анализатор',
  'Электрохирургический аппарат',
  'Бактерицидный облучатель',
  'Физиотерапевтический аппарат',
  'Стоматологическая установка',
  'Эндоскоп',
  'Микроскоп',
  'Кардиограф',
  'Пульсоксиметр',
];

/** Объединяет частые типы с уже введёнными (из БД), без дублей, с сохранением порядка. */
export function mergeDeviceTypeSuggestions(used: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...(used ?? []), ...COMMON_DEVICE_TYPES]) {
    const key = t.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Убирает дубли без учёта регистра, сохраняя порядок первого появления. */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const t = raw.trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Кнопки «какую технику обслуживает инженер».
 *
 * Главный источник — РЕАЛЬНЫЙ словарь типов из базы (архив ремонтов + заведённая
 * техника, по частоте): навык и тип техники обязаны быть одними и теми же словами,
 * иначе они не совпадут никогда. Список из кода — только запасной, на случай пустой
 * базы у нового тенанта; подмешивать его к реальному словарю нельзя, это снова даст
 * два разных набора слов на один смысл.
 *
 * Уже отмеченное человеку добавляем всегда — иначе редкий свой тип пропал бы из вида.
 */
export function deviceTypeOptions(
  vocabulary: readonly string[] | undefined,
  own: readonly string[],
): string[] {
  const base = vocabulary && vocabulary.length > 0 ? vocabulary : COMMON_DEVICE_TYPES;
  return dedupe([...base, ...own]);
}

/**
 * Ни у одного инженера не отмечена техника заявки. Тогда честнее написать это одной
 * строкой, чем ставить «нет навыка» каждому: виновата незаполненность, а не люди.
 * При неизвестном типе техники (hasSkill = null) сравнивать не с чем — не считается.
 */
export function nobodyHasSkill(hints: ReadonlyArray<{ hasSkill: boolean | null }>): boolean {
  return hints.length > 0 && hints.every((h) => h.hasSkill === false);
}
