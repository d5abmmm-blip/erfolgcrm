/**
 * Единый список разделов навигации для сотрудников (staff).
 *
 * Используется десктопной оболочкой (AppShell) и мобильной оболочкой директора/
 * диспетчера (StaffMobileShell) — чтобы меню было в ОДНОМ месте и не расходилось.
 */
import {
  LayoutDashboard,
  LayoutGrid,
  Ticket,
  Users,
  Wrench,
  Package,
  Calendar,
  CalendarCheck,
  CalendarDays,
  Receipt,
  FileSignature,
  Settings,
  Wallet,
  ShoppingCart,
  Target,
  ShieldCheck,
  BarChart3,
  Recycle,
  Map as MapIcon,
  BookOpen,
  Mail,
  Hourglass,
} from 'lucide-react';
import type { ModuleKey } from './modules';

export type Role = 'director' | 'dispatcher' | 'engineer';

export const ROLE_LABELS: Record<Role, string> = {
  director: 'Директор',
  dispatcher: 'Диспетчер',
  engineer: 'Инженер',
};

export type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Если задано — пункт виден только этим ролям. */
  roles?: Role[];
  /**
   * Если задано — это отключаемый раздел (см. lib/modules.ts). Когда ключ в
   * disabledModules tenant'а, пункт скрыт из меню, а маршрут заблокирован.
   * Пункты без `module` — «ядро», их отключить нельзя.
   */
  module?: ModuleKey;
};

export type NavGroup = { label: string; items: readonly NavItem[] };

/**
 * Меню сгруппировано по смыслу — глазу не нужно сканировать 17 пунктов
 * подряд: «Работа» (ежедневное), «Картотека» (справочники), «Деньги», «Система».
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Работа',
    items: [
      { href: '/', label: 'Дашборд', icon: LayoutDashboard },
      { href: '/board', label: 'Доска', icon: LayoutGrid, roles: ['director', 'dispatcher'] },
      { href: '/tickets', label: 'Заявки', icon: Ticket },
      { href: '/parts-waiting', label: 'Ожидание запчастей', icon: Hourglass, roles: ['director', 'dispatcher'] },
      { href: '/leads', label: 'Лиды', icon: Target, roles: ['director', 'dispatcher'], module: 'leads' },
      { href: '/schedule', label: 'График (детально)', icon: Calendar, roles: ['director', 'dispatcher'], module: 'schedule' },
      { href: '/calendar', label: 'Календарь', icon: CalendarDays, roles: ['director', 'dispatcher'], module: 'calendar' },
      { href: '/kb', label: 'База знаний', icon: BookOpen, module: 'kb' },
      { href: '/mail', label: 'Почта', icon: Mail, roles: ['director', 'dispatcher'], module: 'mail' },
    ],
  },
  {
    label: 'Картотека',
    items: [
      { href: '/clients', label: 'Клиенты', icon: Users },
      { href: '/contracts', label: 'Договоры', icon: FileSignature, module: 'contracts' },
      { href: '/assets', label: 'Техника', icon: Wrench, module: 'assets' },
      { href: '/inventory', label: 'Склад', icon: Package, module: 'inventory' },
      { href: '/maintenance', label: 'Журнал ТО', icon: CalendarCheck, module: 'maintenance' },
      { href: '/warranties', label: 'Гарантии', icon: ShieldCheck, module: 'warranties' },
      { href: '/trade-in', label: 'Трейд-ин', icon: Recycle, roles: ['director', 'dispatcher'], module: 'tradeIn' },
    ],
  },
  {
    label: 'Деньги',
    items: [
      { href: '/finance', label: 'Финансы', icon: Receipt, module: 'invoices' },
      { href: '/sales', label: 'Продажи', icon: ShoppingCart, roles: ['director', 'dispatcher'], module: 'sales' },
      { href: '/payroll', label: 'Зарплата', icon: Wallet, module: 'payroll' },
      { href: '/reports', label: 'Отчёты', icon: BarChart3, roles: ['director', 'dispatcher'], module: 'reports' },
    ],
  },
  {
    label: 'Система',
    items: [
      { href: '/roadmap', label: 'Дорожная карта', icon: MapIcon, roles: ['director'], module: 'roadmap' },
      { href: '/settings', label: 'Настройки', icon: Settings },
    ],
  },
];

export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Пункт меню, видимый данной роли и при включённом модуле. */
export function isNavItemVisible(
  item: NavItem,
  role: Role,
  disabledModules: string[],
): boolean {
  return (
    (!item.roles || item.roles.includes(role)) &&
    (!item.module || !disabledModules.includes(item.module))
  );
}
