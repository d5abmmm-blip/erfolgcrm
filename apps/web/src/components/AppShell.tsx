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
} from 'lucide-react';
import { useTheme } from '../lib/theme';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { GlobalSearchModal } from './GlobalSearchModal';

interface SessionInfo {
  user: { id: string; username: string; fullName: string; role: 'director' | 'dispatcher' | 'engineer' };
  tenant: { id: string; subdomain: string; displayName: string };
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
};

const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Дашборд', icon: LayoutDashboard },
  { href: '/tickets', label: 'Заявки', icon: Ticket },
  { href: '/leads', label: 'Лиды', icon: Target, roles: ['director', 'dispatcher'] },
  { href: '/schedule', label: 'График', icon: Calendar, roles: ['director', 'dispatcher'] },
  { href: '/clients', label: 'Клиенты', icon: Users },
  { href: '/contracts', label: 'Договоры', icon: FileSignature },
  { href: '/assets', label: 'Техника', icon: Wrench },
  { href: '/inventory', label: 'Склад', icon: Package },
  { href: '/maintenance', label: 'Журнал ТО', icon: CalendarCheck },
  { href: '/warranties', label: 'Гарантии', icon: ShieldCheck },
  { href: '/trade-in', label: 'Трейд-ин', icon: Recycle, roles: ['director', 'dispatcher'] },
  { href: '/kb', label: 'База знаний', icon: BookOpen },
  { href: '/invoices', label: 'Финансы', icon: Receipt },
  { href: '/payroll', label: 'Зарплата', icon: Wallet },
  { href: '/reports', label: 'Отчёты', icon: BarChart3, roles: ['director', 'dispatcher'] },
  { href: '/roadmap', label: 'Дорожная карта', icon: MapIcon, roles: ['director'] },
  { href: '/settings', label: 'Настройки', icon: Settings },
];

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

  const initials = session.user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-full">
      <aside className="bg-card hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <img src="/favicon.png" alt="ErfolgCRM" className="h-8 w-8" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">ErfolgCRM</div>
            <div className="text-muted-foreground text-xs">ООО «Эрфольг»</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV_ITEMS.filter(
            (item) => !item.roles || item.roles.includes(session.user.role),
          ).map((item) => {
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
                    ? 'bg-secondary text-secondary-foreground font-medium'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-3">
          <div className="bg-muted/50 group flex items-center gap-2 rounded-md p-2">
            <div className="bg-primary/10 text-primary grid h-8 w-8 place-items-center rounded-full text-xs font-semibold">
              {initials || '??'}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-xs font-medium" title={session.user.fullName}>
                {session.user.fullName}
              </div>
              <div className="text-muted-foreground text-[11px]">{ROLE_LABELS[session.user.role]}</div>
            </div>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="text-muted-foreground hover:text-foreground hover:bg-background grid h-7 w-7 place-items-center rounded transition disabled:opacity-50"
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
