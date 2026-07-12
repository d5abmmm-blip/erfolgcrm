import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  LayoutDashboard,
  LayoutGrid,
  Ticket,
  Receipt,
  Search,
  Menu,
  X,
  LogOut,
  Monitor,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { NAV_GROUPS, NAV_ITEMS, ROLE_LABELS, isNavItemVisible, type Role } from '../lib/nav';
import { GlobalSearchModal } from './GlobalSearchModal';

interface SessionInfo {
  user: { id: string; username: string; fullName: string; role: Role };
  tenant: { id: string; subdomain: string; displayName: string; disabledModules: string[] };
}

interface Props {
  children: ReactNode;
  session: SessionInfo;
  /** Переход в десктопную вёрстку (кнопка «Полная версия» в листе «Ещё»). */
  onUseFullVersion: () => void;
}

type Tab = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  match: (p: string) => boolean;
  /** Отключаемый раздел — прячем таб, если модуль выключен. */
  module?: string;
};

const TABS: Tab[] = [
  { href: '/', label: 'Сводка', icon: LayoutDashboard, match: (p) => p === '/' },
  { href: '/board', label: 'Доска', icon: LayoutGrid, match: (p) => p.startsWith('/board') },
  { href: '/tickets', label: 'Заявки', icon: Ticket, match: (p) => p.startsWith('/tickets') },
  {
    href: '/finance',
    label: 'Деньги',
    icon: Receipt,
    match: (p) => p.startsWith('/finance') || p.startsWith('/invoices'),
    module: 'invoices',
  },
];

export function StaffMobileShell({ children, session, onUseFullVersion }: Props) {
  const [location] = useLocation();
  const utils = trpc.useUtils();
  const logout = trpc.auth.logout.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const disabledModules = session.tenant.disabledModules;
  const role = session.user.role;

  const navBadges = trpc.dashboard.navBadges.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const nb = navBadges.data;
  const badgeByHref: Record<string, number> = {
    '/tickets': nb?.ticketsAttention ?? 0,
    '/finance': nb?.invoicesOverdue ?? 0,
  };

  const tabs = TABS.filter((t) => !t.module || !disabledModules.includes(t.module));

  const title =
    NAV_ITEMS.find((n) => (n.href === '/' ? location === '/' : location.startsWith(n.href)))?.label ??
    'ErfolgCRM';

  const initials = session.user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();

  // «Ещё» = все разделы меню, кроме тех, что уже в нижней панели.
  const tabHrefs = new Set(tabs.map((t) => t.href));

  return (
    <div className="bg-background flex h-full min-h-[100dvh] flex-col">
      <header
        className="bg-sidebar text-sidebar-foreground sticky top-0 z-30 flex h-14 items-center justify-between gap-2 px-3"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/favicon.png" alt="Эрфольг" className="h-8 w-8 shrink-0 rounded-md" />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold">{title}</div>
            <div className="text-sidebar-muted truncate text-[11px]">
              {ROLE_LABELS[role]} · {session.tenant.displayName}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="Поиск"
          className="text-sidebar-muted hover:text-sidebar-foreground grid h-9 w-9 shrink-0 place-items-center rounded-lg transition"
        >
          <Search className="h-5 w-5" />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto overscroll-contain pb-20">{children}</main>

      <nav
        className="bg-card fixed inset-x-0 bottom-0 z-30 grid h-16 border-t"
        style={{
          paddingBottom: 'env(safe-area-inset-bottom)',
          gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))`,
        }}
      >
        {tabs.map((t) => {
          const isActive = t.match(location);
          const Icon = t.icon;
          const badge = badgeByHref[t.href] ?? 0;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 transition',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'relative grid h-8 w-12 place-items-center rounded-xl transition',
                  isActive && 'bg-primary/12',
                )}
              >
                <Icon className="h-5.5 w-5.5" />
                {badge > 0 && (
                  <span className="bg-destructive text-destructive-foreground absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-4 tabular-nums">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </span>
              <span className={cn('text-[11px]', isActive ? 'font-semibold' : 'font-medium')}>
                {t.label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className="text-muted-foreground flex flex-col items-center justify-center gap-0.5 transition"
        >
          <span className="grid h-8 w-12 place-items-center rounded-xl">
            <Menu className="h-5.5 w-5.5" />
          </span>
          <span className="text-[11px] font-medium">Ещё</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Закрыть"
            onClick={() => setMoreOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <div
            className="bg-card absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl border-t shadow-xl"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="font-semibold">Все разделы</div>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Закрыть"
                className="text-muted-foreground hover:text-foreground grid h-8 w-8 place-items-center rounded-lg"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-2 py-2">
              {NAV_GROUPS.map((group) => {
                const items = group.items.filter(
                  (item) =>
                    isNavItemVisible(item, role, disabledModules) && !tabHrefs.has(item.href),
                );
                if (items.length === 0) return null;
                return (
                  <div key={group.label} className="mb-1">
                    <div className="text-muted-foreground px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em]">
                      {group.label}
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      {items.map((item) => {
                        const Icon = item.icon;
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            onClick={() => setMoreOpen(false)}
                            className="hover:bg-muted flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition"
                          >
                            <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
                            <span className="truncate">{item.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="space-y-2 border-t p-3">
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  onUseFullVersion();
                }}
                className="hover:bg-muted flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm font-medium transition"
              >
                <Monitor className="h-4 w-4" />
                Полная версия (десктоп)
              </button>
              <div className="bg-muted/40 flex items-center gap-2.5 rounded-lg p-2">
                <div className="bg-primary/15 text-primary grid h-9 w-9 place-items-center rounded-full text-sm font-semibold">
                  {initials || '??'}
                </div>
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-sm font-medium">{session.user.fullName}</div>
                  <div className="text-muted-foreground text-[11px]">{ROLE_LABELS[role]}</div>
                </div>
                <button
                  type="button"
                  onClick={() => logout.mutate()}
                  disabled={logout.isPending}
                  className="text-muted-foreground hover:text-foreground hover:bg-background inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" />
                  Выйти
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <GlobalSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
