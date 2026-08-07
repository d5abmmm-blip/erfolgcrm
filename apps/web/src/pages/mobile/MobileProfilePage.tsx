import { Link } from 'wouter';
import {
  ExternalLink,
  LogOut,
  ListChecks,
  Mail,
  Building2,
  BadgeCheck,
  ChevronRight,
  Wallet,
} from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { formatRubWhole } from '../../lib/money';
import { useOutbox } from '../../lib/offline/useOutbox';
import { markEngineerWantsDesktop } from '../../lib/engineer-redirect';
import { TelegramLinkSection } from '../../components/TelegramLinkSection';
import { OutboxRejectedList } from '../../components/OutboxRejectedList';

const ROLE_LABEL: Record<'director' | 'dispatcher' | 'engineer', string> = {
  director: 'Директор',
  dispatcher: 'Диспетчер',
  engineer: 'Инженер',
};

export function MobileProfilePage() {
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const logout = trpc.auth.logout.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const outbox = useOutbox();

  // Заработок показываем инженеру (myEarnings — только для роли engineer) и только
  // если раздел «Зарплата» не отключён в компании. Тот же запрос переиспользует
  // экран /m/earnings (кэш react-query по одному ключу).
  const canQueryEarnings =
    me.data?.user.role === 'engineer' && !me.data.tenant.disabledModules.includes('payroll');
  const earningsQ = trpc.payroll.myEarnings.useQuery(
    { preset: 'month' },
    { enabled: canQueryEarnings },
  );
  const earnings = earningsQ.data?.enabled ? earningsQ.data : null;
  // Прячем карточку, если директор отключил показ (сервер вернул enabled: false).
  const showEarnings = canQueryEarnings && earningsQ.data?.enabled !== false;

  if (!me.data) return null;
  const { user, tenant } = me.data;

  return (
    <div className="space-y-3 p-3">
      <div className="bg-card space-y-3 rounded-lg border p-4">
        <div className="text-muted-foreground text-[11px] font-medium uppercase">Сотрудник</div>
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary grid h-12 w-12 place-items-center rounded-full font-semibold">
            {user.fullName
              .split(/\s+/)
              .slice(0, 2)
              .map((s) => s[0])
              .join('')
              .toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="font-semibold">{user.fullName}</div>
            <div className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <BadgeCheck className="h-3.5 w-3.5" />
              {ROLE_LABEL[user.role]}
            </div>
            <div className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <Mail className="h-3.5 w-3.5" />
              {user.username}
            </div>
          </div>
        </div>
        <div className="border-t pt-3">
          <div className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <Building2 className="h-3.5 w-3.5" />
            {tenant.displayName}{' '}
            <span className="text-muted-foreground/60">· {tenant.subdomain}</span>
          </div>
        </div>
      </div>

      {showEarnings && (
        <Link
          href="/m/earnings"
          className="bg-card hover:bg-muted/40 flex items-center justify-between gap-3 rounded-lg border p-4"
        >
          <div className="flex items-center gap-3">
            <div className="bg-success/10 text-success grid h-10 w-10 place-items-center rounded-full">
              <Wallet className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">Мой заработок</div>
              <div className="text-muted-foreground text-xs">
                За месяц ·{' '}
                <span className="text-success font-semibold tabular-nums">
                  {earnings ? formatRubWhole(earnings.grandTotalKopecks) : '—'}
                </span>
              </div>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" />
        </Link>
      )}

      <div className="bg-card space-y-2 rounded-lg border p-4">
        <div className="text-muted-foreground text-[11px] font-medium uppercase">
          Telegram-напоминания
        </div>
        <TelegramLinkSection />
      </div>

      {/* Отклонённое сервером больше не пропадает — вот оно, с причиной
          и кнопками. Блок сам прячется, когда всё отправлено. */}
      <OutboxRejectedList onRetryAll={() => void outbox.sync()} />

      <div className="bg-card space-y-2 rounded-lg border p-4">
        <div className="text-muted-foreground text-[11px] font-medium uppercase">Синхронизация</div>
        <div className="flex items-center justify-between">
          <div className="text-sm">
            {outbox.isOnline ? 'Онлайн' : 'Нет связи'} · в очереди {outbox.pending}
          </div>
          <button
            type="button"
            onClick={() => void outbox.sync()}
            disabled={!outbox.isOnline || outbox.pending === 0 || outbox.isSyncing}
            className="bg-primary text-primary-foreground inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-50"
          >
            {outbox.isSyncing ? 'Синк…' : 'Синхронизировать'}
          </button>
        </div>
      </div>

      {/* Явное намерение: без флага автопереход инженера с '/' вернул бы его
          обратно в очередь, и полная версия осталась бы недостижимой. */}
      <Link
        href="/"
        onClick={markEngineerWantsDesktop}
        className="bg-card hover:bg-muted/40 flex items-center justify-between gap-2 rounded-lg border p-4 text-sm"
      >
        <span className="inline-flex items-center gap-2">
          <ExternalLink className="h-4 w-4" />
          Открыть полную версию
        </span>
        <ListChecks className="text-muted-foreground h-4 w-4" />
      </Link>

      <button
        type="button"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
        className="bg-destructive/10 text-destructive hover:bg-destructive/20 flex h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium disabled:opacity-50"
      >
        <LogOut className="h-4 w-4" />
        Выйти
      </button>
    </div>
  );
}
