/**
 * Реестр отключаемых разделов (модулей) интерфейса.
 *
 * Директор может скрыть необязательные разделы в «Настройки → Разделы». Отключение
 * влияет ТОЛЬКО на навигацию и маршруты: данные и API остаются живыми, поэтому
 * скрыть можно лишь те разделы, без которых не ломается логика.
 *
 * «Ядро» отключить НЕЛЬЗЯ — его здесь нет:
 *   • Дашборд (/)        — стартовый маршрут;
 *   • Заявки (/tickets)  — центральная сущность (к ней привязаны наряды, счета,
 *                          календарь, график, КП);
 *   • Клиенты (/clients) — без них некому выставлять заявки и счета;
 *   • Настройки          — иначе нельзя вернуть отключённое обратно.
 *
 * Это ЕДИНЫЙ источник правды: ключи модулей совпадают с `module` у пунктов меню в
 * AppShell/MobileShell, а бэкенд (settings.setDisabledModules) лишь хранит выбор.
 * При добавлении нового раздела: добавить пункт сюда и проставить ему `module` в меню.
 */

export type ModuleKey =
  | 'leads'
  | 'schedule'
  | 'calendar'
  | 'attendance'
  | 'staff'
  | 'kb'
  | 'contracts'
  | 'assets'
  | 'inventory'
  | 'maintenance'
  | 'warranties'
  | 'tradeIn'
  | 'invoices'
  | 'payroll'
  | 'reports'
  | 'roadmap'
  | 'mail'
  | 'sales'
  | 'tenders';

export type ModuleGroup = 'Работа' | 'Картотека' | 'Деньги' | 'Система';

export interface ModuleMeta {
  key: ModuleKey;
  /** Короткое имя — как в меню. */
  label: string;
  /** Группа меню (для удобной раскладки на странице настроек). */
  group: ModuleGroup;
  /** Что это и зачем — подсказка на странице настроек. */
  description: string;
  /** Префиксы маршрутов раздела — для блокировки прямого перехода по URL. */
  routes: string[];
}

export const TOGGLEABLE_MODULES: readonly ModuleMeta[] = [
  // Работа
  {
    key: 'leads',
    label: 'Лиды',
    group: 'Работа',
    description: 'Воронка продаж и входящие обращения',
    routes: ['/leads'],
  },
  {
    key: 'schedule',
    label: 'График',
    group: 'Работа',
    description: 'Расписание загрузки инженеров по дням',
    routes: ['/schedule'],
  },
  {
    key: 'calendar',
    label: 'Календарь',
    group: 'Работа',
    description: 'События компании: выезды, дедлайны, окончания договоров',
    routes: ['/calendar'],
  },
  {
    key: 'attendance',
    label: 'Посещения',
    group: 'Работа',
    description: 'Журнал учёта посещений сотрудников (табель) с печатной формой',
    routes: ['/attendance'],
  },
  {
    key: 'staff',
    label: 'Сотрудники',
    group: 'Работа',
    description: 'Кто чем занят сейчас и карточка сотрудника',
    routes: ['/staff'],
  },
  {
    key: 'kb',
    label: 'База знаний',
    group: 'Работа',
    description: 'Внутренняя вики по моделям техники и типовым случаям',
    routes: ['/kb'],
  },
  {
    key: 'mail',
    label: 'Почта',
    group: 'Работа',
    description: 'Исходящие письма клиентам, журнал отправки и шаблоны',
    routes: ['/mail'],
  },
  // Картотека
  {
    key: 'contracts',
    label: 'Договоры',
    group: 'Картотека',
    description: 'Договоры на обслуживание и разовые работы',
    routes: ['/contracts'],
  },
  {
    key: 'assets',
    label: 'Техника',
    group: 'Картотека',
    description: 'Парк обслуживаемой медтехники клиентов',
    routes: ['/assets'],
  },
  {
    key: 'inventory',
    label: 'Склад',
    group: 'Картотека',
    description: 'Запчасти и расходники, списание в наряды (FEFO)',
    routes: ['/inventory'],
  },
  {
    key: 'maintenance',
    label: 'Журнал ТО',
    group: 'Картотека',
    description: 'Плановое техобслуживание и его история',
    routes: ['/maintenance'],
  },
  {
    key: 'warranties',
    label: 'Гарантии',
    group: 'Картотека',
    description: 'Гарантийные обязательства на технику',
    routes: ['/warranties'],
  },
  {
    key: 'tradeIn',
    label: 'Трейд-ин',
    group: 'Картотека',
    description: 'Приём б/у техники в зачёт',
    routes: ['/trade-in'],
  },
  // Деньги
  {
    key: 'invoices',
    label: 'Финансы',
    group: 'Деньги',
    description: 'Касса (доходы/расходы), счета на оплату, остатки и обзор',
    routes: ['/finance', '/invoices'],
  },
  {
    key: 'sales',
    label: 'Продажи',
    group: 'Деньги',
    description: 'Продажа запчастей и оборудования клиентам (отдельно от заявок)',
    routes: ['/sales'],
  },
  {
    key: 'tenders',
    label: 'Тендеры',
    group: 'Деньги',
    description: 'Реестр тендерных контрактов: реальные суммы, статусы, оплаты по этапам',
    routes: ['/tenders'],
  },
  {
    key: 'payroll',
    label: 'Зарплата',
    group: 'Деньги',
    description: 'Расчёт зарплаты инженеров (сделка/оклад)',
    routes: ['/payroll'],
  },
  {
    key: 'reports',
    label: 'Отчёты',
    group: 'Деньги',
    description: 'Аналитические отчёты по периодам',
    routes: ['/reports'],
  },
  // Система
  {
    key: 'roadmap',
    label: 'Дорожная карта',
    group: 'Система',
    description: 'Цели компании по кварталам',
    routes: ['/roadmap'],
  },
];

/** Маршрут → ключ модуля. Длинные префиксы раньше, чтобы не «съесть» вложенные. */
const ROUTE_TO_MODULE: ReadonlyArray<{ prefix: string; key: ModuleKey }> =
  TOGGLEABLE_MODULES.flatMap((m) => m.routes.map((prefix) => ({ prefix, key: m.key }))).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );

/** Какому отключаемому модулю принадлежит путь (или null — это ядро/нейтральный путь). */
export function moduleForPath(path: string): ModuleKey | null {
  for (const { prefix, key } of ROUTE_TO_MODULE) {
    if (path === prefix || path.startsWith(prefix + '/')) return key;
  }
  return null;
}

/** Отключён ли путь текущим набором disabledModules (для гварда маршрутов). */
export function isPathDisabled(disabledModules: readonly string[], path: string): boolean {
  const key = moduleForPath(path);
  return key != null && disabledModules.includes(key);
}

/** Группы в порядке отображения на странице настроек. */
export const MODULE_GROUP_ORDER: readonly ModuleGroup[] = [
  'Работа',
  'Картотека',
  'Деньги',
  'Система',
];
