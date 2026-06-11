import type { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  LayoutDashboard,
  Ticket,
  Wrench,
  Receipt,
  FileSignature,
  User,
  LogOut,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

interface ClientSessionInfo {
  user: {
    id: string;
    email: string;
    fullName: string;
    clientId: string;
    clientDisplayName: string | null;
  };
  tenant: { subdomain: string; displayName: string };
}

interface ClientShellProps {
  children: ReactNode;
  session: ClientSessionInfo;
}

const NAV_ITEMS: ReadonlyArray<{ href: string; label: string; icon: typeof LayoutDashboard }> = [
  { href: '/client', label: 'Главная', icon: LayoutDashboard },
  { href: '/client/tickets', label: 'Заявки', icon: Ticket },
  { href: '/client/assets', label: 'Техника', icon: Wrench },
  { href: '/client/invoices', label: 'Счета', icon: Receipt },
  { href: '/client/contracts', label: 'Договоры', icon: FileSignature },
  { href: '/client/profile', label: 'Профиль', icon: User },
];

export function ClientShell({ children, session }: ClientShellProps) {
  const [location] = useLocation();
  const utils = trpc.useUtils();
  const logout = trpc.clientAuth.logout.useMutation({
    onSuccess: () => utils.clientAuth.me.invalidate(),
  });

  const initials = session.user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-full">
      <aside className="bg-card hidden w-64 shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <img src="/favicon.png" alt="ErfolgCRM" className="h-8 w-8" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">Кабинет клиента</div>
            <div className="text-muted-foreground text-xs">ООО Эрфольг</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.href === '/client'
                ? location === '/client' || location === '/client/'
                : location.startsWith(item.href);
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
              {initials || '?'}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-xs font-medium" title={session.user.fullName}>
                {session.user.fullName}
              </div>
              <div
                className="text-muted-foreground truncate text-[11px]"
                title={session.user.clientDisplayName ?? ''}
              >
                {session.user.clientDisplayName ?? session.user.email}
              </div>
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
              {NAV_ITEMS.find((n) =>
                n.href === '/client'
                  ? location === '/client' || location === '/client/'
                  : location.startsWith(n.href),
              )?.label ?? 'Кабинет'}
            </h1>
            <span className="bg-secondary text-muted-foreground hidden rounded-md px-2 py-0.5 text-xs md:inline">
              {session.user.clientDisplayName ?? session.user.email}
            </span>
          </div>
        </header>

        {/* Мобильный нижний таб-бар */}
        <nav className="bg-card flex items-center justify-around border-b py-2 md:hidden">
          {NAV_ITEMS.slice(0, 5).map((item) => {
            const isActive =
              item.href === '/client'
                ? location === '/client' || location === '/client/'
                : location.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex flex-col items-center gap-0.5 px-2 py-1 text-[11px]',
                  isActive ? 'text-primary font-medium' : 'text-muted-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
