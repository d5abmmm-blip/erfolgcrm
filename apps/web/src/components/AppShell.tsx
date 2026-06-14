import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  LayoutDashboard,
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
  Target,
  ShieldCheck,
  BarChart3,
  Recycle,
  Map as MapIcon,
  Sun,
  Moon,
  Monitor,
  LogOut,
  Search,
  BookOpen,
  Mail,
} from 'lucide-react';
import { useTheme } from '../lib/theme';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import type { ModuleKey } from '../lib/modules';
import { GlobalSearchModal } from './GlobalSearchModal';

interface SessionInfo {
  user: { id: string; username: string; fullName: string; role: 'director' | 'dispatcher' | 'engineer' };
  tenant: { id: string; subdomain: string; displayName: string; disabledModules: string[] };
}

interface AppShellProps {
  children: ReactNode;
  session: SessionInfo;
}

const ROLE_LABELS: Record<SessionInfo['user']['role'], string> = {
  director: 'Директор',
  dispatcher: 'Диспетчер',
  engineer: 'Инженер',
};

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Если задано — пункт виден только этим ролям. */
  roles?: Array<SessionInfo['user']['role']>;
  /**
   * Если задано — это отключаемый раздел (см. lib/modules.ts). Когда ключ в
   * disabledModules tenant'а, пункт скрыт из меню, а маршрут заблокирован.
   * Пункты без `module` — «ядро», их отключить нельзя.
   */
  module?: ModuleKey;
};

type NavGroup = { label: string; items: readonly NavItem[] };

/**
 * Меню сгруппировано по смыслу — глазу не нужно сканировать 17 пунктов
 * подряд: «Работа» (ежедневное), «Картотека» (справочники), «Деньги», «Система».
 */
const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Работа',
    items: [
      { href: '/', label: 'Дашборд', icon: LayoutDashboard },
      { href: '/tickets', label: 'Заявки', icon: Ticket },
      { href: '/leads', label: 'Лиды', icon: Target, roles: ['director', 'dispatcher'], module: 'leads' },
      { href: '/schedule', label: 'График', icon: Calendar, roles: ['director', 'dispatcher'], module: 'schedule' },
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
      { href: '/invoices', label: 'Финансы', icon: Receipt, module: 'invoices' },
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

const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function AppShell({ children, session }: AppShellProps) {
  const [location] = useLocation();
  const utils = trpc.useUtils();
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => utils.auth.me.invalidate(),
  });
  const [searchOpen, setSearchOpen] = useState(false);

  // Cmd+K (Mac) / Ctrl+K (Win/Linux) — открыть глобальный поиск.
  // Реагируем на любой layout: e.key === 'k', плюс metaKey/ctrlKey.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const disabledModules = session.tenant.disabledModules;

  const initials = session.user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-full">
      <aside className="bg-sidebar text-sidebar-foreground hidden w-60 shrink-0 flex-col md:flex">
        <div className="border-sidebar-border flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
          <img src="/favicon.png" alt="ErfolgCRM" className="h-8 w-8 rounded-md" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">ErfolgCRM</div>
            <div className="text-sidebar-muted text-xs">ООО «Эрфольг»</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {NAV_GROUPS.map((group) => {
            const visible = group.items.filter(
              (item) =>
                (!item.roles || item.roles.includes(session.user.role)) &&
                (!item.module || !disabledModules.includes(item.module)),
            );
            if (visible.length === 0) return null;
            return (
              <div key={group.label}>
                <div className="text-sidebar-muted/75 px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em]">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {visible.map((item) => {
                    const isActive =
                      item.href === '/' ? location === '/' : location.startsWith(item.href);
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition',
                          isActive
                            ? 'bg-primary text-primary-foreground font-medium shadow-sm'
                            : 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground',
                        )}
                      >
                        <Icon
                          className={cn(
                            'h-4 w-4 shrink-0',
                            !isActive && 'opacity-75 transition group-hover:opacity-100',
                          )}
                        />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="border-sidebar-border border-t p-3">
          <div className="bg-sidebar-hover group flex items-center gap-2 rounded-md p-2">
            <div className="bg-primary/25 text-sidebar-foreground grid h-8 w-8 place-items-center rounded-full text-xs font-semibold">
              {initials || '??'}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-xs font-medium" title={session.user.fullName}>
                {session.user.fullName}
              </div>
              <div className="text-sidebar-muted text-[11px]">{ROLE_LABELS[session.user.role]}</div>
            </div>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar grid h-7 w-7 place-items-center rounded transition disabled:opacity-50"
              aria-label="Выйти"
              title="Выйти"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="bg-card flex h-14 items-center justify-between border-b px-4 md:px-6">
          <div className="flex items-center gap-3">
            <span className="bg-primary h-5 w-1 rounded-full" aria-hidden />
            <h1 className="text-base font-semibold md:text-lg">
              {NAV_ITEMS.find((n) => (n.href === '/' ? location === '/' : location.startsWith(n.href)))
                ?.label ?? 'ErfolgCRM'}
            </h1>
            <span className="bg-secondary text-muted-foreground hidden rounded-md px-2 py-0.5 text-xs md:inline">
              {session.tenant.displayName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              title="Поиск (Ctrl+K)"
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs transition"
              aria-label="Открыть глобальный поиск (Ctrl+K)"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Поиск</span>
              <kbd className="bg-secondary text-muted-foreground hidden rounded px-1.5 py-0.5 text-[10px] md:inline">
                Ctrl K
              </kbd>
            </button>
            <ThemeSwitcher />
          </div>
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
      <GlobalSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const options: Array<{ value: 'light' | 'dark' | 'system'; icon: typeof Sun; label: string }> = [
    { value: 'light', icon: Sun, label: 'Светлая' },
    { value: 'dark', icon: Moon, label: 'Тёмная' },
    { value: 'system', icon: Monitor, label: 'Системная' },
  ];
  return (
    <div className="bg-secondary inline-flex rounded-md p-0.5">
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          aria-label={label}
          title={label}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded transition',
            theme === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
