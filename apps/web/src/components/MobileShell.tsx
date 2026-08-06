import { useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ClipboardList, ListChecks, Package, ScanLine, User, CloudOff, Cloud } from 'lucide-react';
import { useOutbox } from '../lib/offline/useOutbox';
import { useAppViewportLock } from '../lib/use-app-viewport-lock';
import { cn } from '../lib/utils';
import type { ModuleKey } from '../lib/modules';

interface SessionInfo {
  user: {
    id: string;
    username: string;
    fullName: string;
    role: 'director' | 'dispatcher' | 'engineer';
  };
  tenant: { id: string; subdomain: string; displayName: string; disabledModules: string[] };
}

interface Props {
  children: ReactNode;
  session: SessionInfo;
}

const NAV: Array<{
  href: string;
  label: string;
  icon: typeof ListChecks;
  match: (p: string) => boolean;
  /** Отключаемый раздел (см. lib/modules.ts) — скрываем вкладку, если выключен. */
  module?: ModuleKey;
}> = [
  {
    href: '/m/queue',
    label: 'Очередь',
    icon: ListChecks,
    match: (p) => p === '/m/queue' || p.startsWith('/m/tickets'),
  },
  {
    href: '/m/tasks',
    label: 'Задачи',
    icon: ClipboardList,
    match: (p) => p.startsWith('/m/tasks'),
  },
  { href: '/m/scan', label: 'Сканер', icon: ScanLine, match: (p) => p.startsWith('/m/scan') },
  {
    href: '/m/inventory',
    label: 'Склад',
    icon: Package,
    match: (p) => p.startsWith('/m/inventory'),
    module: 'inventory',
  },
  { href: '/m/profile', label: 'Профиль', icon: User, match: (p) => p.startsWith('/m/profile') },
];

export function MobileShell({ children, session }: Props) {
  const [location] = useLocation();
  const outbox = useOutbox();

  // Экран ведёт себя как приложение: без зума пальцами и «резинового» отскока.
  // Снимается автоматически при уходе с /m/* (размонтировании оболочки).
  useAppViewportLock();

  // Hint Telegram-like UX: длинные имена ужимаем
  const initials = session.user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();

  // Trigger один автосинк при первом монтировании, если вышли онлайн
  useEffect(() => {
    if (outbox.isOnline && outbox.pending > 0 && !outbox.isSyncing) {
      void outbox.sync();
    }
  }, []);

  const visibleNav = NAV.filter(
    (n) => !n.module || !session.tenant.disabledModules.includes(n.module),
  );

  const headerTitle =
    NAV.find((n) => n.match(location))?.label ??
    (location.startsWith('/m/tickets') ? 'Заявка' : 'ErfolgCRM');

  return (
    <div className="bg-background flex h-full min-h-[100dvh] flex-col overflow-x-hidden">
      {/* Шапка в «чернилах Эрфольга» — как сайдбар десктопа: экран сразу
          делится на навигацию и работу, статус связи виден боковым зрением. */}
      <header
        className="bg-sidebar text-sidebar-foreground sticky top-0 z-30 flex h-14 items-center justify-between px-3"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/favicon.png" alt="Эрфольг" className="h-8 w-8 shrink-0 rounded-md" />
          <div className="bg-primary/25 grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold">
            {initials || '??'}
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold">{headerTitle}</div>
            <div className="text-sidebar-muted truncate text-[11px]">
              {session.user.fullName.split(' ').slice(0, 2).join(' ')} ·{' '}
              {session.tenant.displayName}
            </div>
          </div>
        </div>
        <OutboxBadge
          pending={outbox.pending}
          isOnline={outbox.isOnline}
          isSyncing={outbox.isSyncing}
          onSync={() => void outbox.sync()}
        />
      </header>

      {/* overscroll-contain — прокрутка не «перетекает» на документ (нет отскока).
          overflow-x-hidden — только вертикальный скролл, вбок страница статична. */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-20">
        {children}
      </main>

      <nav
        className="bg-card fixed inset-x-0 bottom-0 z-30 grid h-16 border-t"
        style={{
          paddingBottom: 'env(safe-area-inset-bottom)',
          // Сетка ужимается при скрытых вкладках. «Выйти» здесь больше нет:
          // случайный тап по крайней вкладке разлогинивал инженера в поле,
          // а кнопка выхода и так есть в «Профиле».
          gridTemplateColumns: `repeat(${visibleNav.length}, minmax(0, 1fr))`,
        }}
      >
        {visibleNav.map((n) => {
          const isActive = n.match(location);
          const Icon = n.icon;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 transition',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'grid h-8 w-12 place-items-center rounded-xl transition',
                  isActive && 'bg-primary/12',
                )}
              >
                <Icon className="h-5.5 w-5.5" />
              </span>
              <span className={cn('text-[11px]', isActive ? 'font-semibold' : 'font-medium')}>
                {n.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function OutboxBadge({
  pending,
  isOnline,
  isSyncing,
  onSync,
}: {
  pending: number;
  isOnline: boolean;
  isSyncing: boolean;
  onSync: () => void;
}) {
  // Бейдж живёт на тёмной шапке — тона чуть плотнее, чем на светлом фоне.
  if (isOnline && pending === 0) {
    return (
      <span className="text-sidebar-muted inline-flex items-center gap-1.5 text-[11px]">
        <Cloud className="h-3.5 w-3.5" />
        онлайн
      </span>
    );
  }
  if (!isOnline) {
    return (
      <span className="bg-destructive text-destructive-foreground inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold">
        <CloudOff className="h-3.5 w-3.5" />
        нет связи{pending > 0 ? ` · ${pending}` : ''}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onSync}
      disabled={isSyncing}
      className="bg-warning text-warning-foreground inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold disabled:opacity-60"
    >
      <CloudOff className="h-3.5 w-3.5" />
      {isSyncing ? 'синк…' : `в очереди · ${pending}`}
    </button>
  );
}
