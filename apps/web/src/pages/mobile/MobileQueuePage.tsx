import { Link } from 'wouter';
import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronRight,
  AlertOctagon,
  Clock,
  Loader2,
  Package,
  Wrench,
  RefreshCw,
} from 'lucide-react';
import type { TicketStatus, TicketPriority } from '@erfolg/shared';
import { trpc } from '../../lib/trpc';
import { cn, getMondayOfThisWeek } from '../../lib/utils';
import { PushToggle } from '../../components/PushToggle';

const ACTIVE_STATUSES: TicketStatus[] = [
  'received',
  'diagnostics',
  'estimate',
  'approval',
  'in_progress',
  'act_pending',
];

const STATUS_LABEL: Record<TicketStatus, string> = {
  received: 'Принята',
  diagnostics: 'Диагностика',
  estimate: 'Смета',
  approval: 'Согласование',
  in_progress: 'В работе',
  act_pending: 'Ожидает акта',
  closed: 'Закрыта',
  cancelled: 'Отменена',
};

const STATUS_DOT: Record<TicketStatus, string> = {
  received: 'bg-primary',
  diagnostics: 'bg-primary',
  estimate: 'bg-primary',
  approval: 'bg-warning',
  in_progress: 'bg-warning',
  act_pending: 'bg-accent',
  closed: 'bg-success',
  cancelled: 'bg-destructive',
};

const PRIORITY_BADGE: Record<TicketPriority, { label: string; cls: string }> = {
  low: { label: 'низкий', cls: 'text-muted-foreground' },
  normal: { label: '', cls: '' },
  high: { label: 'высокий', cls: 'bg-warning/15 text-warning' },
  urgent: { label: 'срочный', cls: 'bg-destructive/15 text-destructive' },
};

interface Props {
  engineerId: string;
}

/**
 * /m/queue — заявки, назначенные инженеру. Поллинг 30 сек на новые назначения.
 */
export function MobileQueuePage({ engineerId }: Props) {
  const [tab, setTab] = useState<'active' | 'all'>('active');

  const list = trpc.tickets.list.useQuery(
    {
      engineerId,
      statuses: tab === 'active' ? ACTIVE_STATUSES : undefined,
      pageSize: 100,
    },
    {
      // 30 сек поллинг — это MVP-замена push-уведомлений
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  );

  // Stage 11 — расписание инженера: «Сегодня по графику» / «Завтра по графику».
  const weekStart = useMemo(() => getMondayOfThisWeek(), []);
  const schedule = trpc.tickets.myWeeklySchedule.useQuery(
    { weekStart },
    {
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  );

  const { scheduleHeader, scheduleItems } = useMemo(() => {
    const items = schedule.data ?? [];
    const today = startOfDay(new Date());
    const tomorrow = addDays(today, 1);
    const dayAfterTomorrow = addDays(today, 2);

    const todayItems = items
      .filter((s) => isSameDay(new Date(s.scheduledStartAt), today, tomorrow))
      .sort(
        (a, b) =>
          new Date(a.scheduledStartAt).getTime() - new Date(b.scheduledStartAt).getTime(),
      );
    if (todayItems.length > 0) {
      return { scheduleHeader: 'Сегодня по графику' as const, scheduleItems: todayItems };
    }
    const tomorrowItems = items
      .filter((s) => isSameDay(new Date(s.scheduledStartAt), tomorrow, dayAfterTomorrow))
      .sort(
        (a, b) =>
          new Date(a.scheduledStartAt).getTime() - new Date(b.scheduledStartAt).getTime(),
      );
    if (tomorrowItems.length > 0) {
      return { scheduleHeader: 'Завтра по графику' as const, scheduleItems: tomorrowItems };
    }
    return { scheduleHeader: null, scheduleItems: [] as typeof items };
  }, [schedule.data]);

  // Подсчёт «новых» назначений с прошлого визита для тоста
  const [seenCount, setSeenCount] = useState<number>(() => {
    const v = localStorage.getItem(`m-queue-seen-${engineerId}`);
    return v ? Number(v) : 0;
  });
  const newCount = useMemo(
    () => Math.max(0, (list.data?.total ?? 0) - seenCount),
    [list.data?.total, seenCount],
  );
  useEffect(() => {
    if (list.data?.total !== undefined && newCount === 0) return;
    // ничего не делаем — просто отображаем; пользователь сбрасывает «как прочитано» открытием карточки
  }, [list.data?.total, newCount]);

  const markSeen = () => {
    if (list.data?.total !== undefined) {
      setSeenCount(list.data.total);
      localStorage.setItem(`m-queue-seen-${engineerId}`, String(list.data.total));
    }
  };

  return (
    <div className="flex flex-col">
      <div className="bg-card sticky top-14 z-20 flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="bg-secondary text-secondary-foreground inline-flex rounded-md p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setTab('active')}
            className={cn(
              'rounded px-3 py-1.5 transition',
              tab === 'active' ? 'bg-background shadow-sm' : 'text-muted-foreground',
            )}
          >
            Активные
          </button>
          <button
            type="button"
            onClick={() => setTab('all')}
            className={cn(
              'rounded px-3 py-1.5 transition',
              tab === 'all' ? 'bg-background shadow-sm' : 'text-muted-foreground',
            )}
          >
            Все
          </button>
        </div>
        <button
          type="button"
          onClick={() => list.refetch()}
          className="text-muted-foreground hover:text-foreground hover:bg-muted grid h-9 w-9 place-items-center rounded transition"
          aria-label="Обновить"
          disabled={list.isFetching}
        >
          {list.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>

      <PushToggle />

      {newCount > 0 && (
        <button
          type="button"
          onClick={markSeen}
          className="bg-primary/10 text-primary mx-3 mt-3 flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium"
        >
          <span>Назначено новых: {newCount}</span>
          <span className="text-xs underline-offset-2">отметить просмотренными</span>
        </button>
      )}

      {scheduleHeader && scheduleItems.length > 0 && (
        <section className="px-3 pt-3">
          <div className="mb-2 flex items-center gap-2">
            <CalendarDays className="text-primary h-4 w-4" />
            <h2 className="text-foreground text-sm font-semibold">{scheduleHeader}</h2>
            <span className="text-muted-foreground text-xs">· {scheduleItems.length}</span>
          </div>
          <ul className="space-y-2">
            {scheduleItems.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/m/tickets/${s.id}`}
                  className="bg-primary/5 hover:bg-primary/10 active:bg-primary/15 border-primary/20 flex items-center gap-3 rounded-lg border p-3 transition"
                >
                  <div className="bg-primary/10 text-primary flex min-w-[64px] shrink-0 flex-col items-center justify-center rounded-md px-2 py-1.5">
                    <span className="text-base leading-tight font-semibold tabular-nums">
                      {fmtTime(s.scheduledStartAt)}
                    </span>
                    {s.scheduledEndAt && (
                      <span className="text-[10px] leading-tight opacity-70 tabular-nums">
                        до {fmtTime(s.scheduledEndAt)}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{s.ticketNumber}</span>
                      {PRIORITY_BADGE[s.priority].label && (
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-medium',
                            PRIORITY_BADGE[s.priority].cls,
                          )}
                        >
                          {PRIORITY_BADGE[s.priority].label}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-sm font-medium">{s.clientName}</div>
                    {s.symptom && (
                      <div className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">
                        {s.symptom}
                      </div>
                    )}
                  </div>
                  <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {list.isLoading && (
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка очереди…
        </div>
      )}

      {list.error && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 m-3 rounded-md border p-3 text-sm">
          {list.error.message}
        </div>
      )}

      {list.data && list.data.items.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Package className="h-10 w-10 opacity-50" />
          <div className="text-sm">
            Очередь пуста.
            <br />
            Заявки появятся когда диспетчер вас назначит.
          </div>
        </div>
      )}

      <ul className="space-y-2 p-3">
        {list.data?.items.map((t) => {
          const overdue =
            t.deadlineAt && new Date(t.deadlineAt).getTime() < Date.now() && t.status !== 'closed';
          return (
            <li key={t.id}>
              <Link
                href={`/m/tickets/${t.id}`}
                className="bg-card hover:bg-muted/40 active:bg-muted/60 flex items-center justify-between gap-2 rounded-lg border p-3 transition"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn('h-2.5 w-2.5 rounded-full', STATUS_DOT[t.status])}
                      aria-hidden
                    />
                    <span className="font-mono text-sm font-semibold">{t.ticketNumber}</span>
                    <span className="text-muted-foreground text-xs">
                      · {STATUS_LABEL[t.status]}
                    </span>
                    {PRIORITY_BADGE[t.priority].label && (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-medium',
                          PRIORITY_BADGE[t.priority].cls,
                        )}
                      >
                        {PRIORITY_BADGE[t.priority].label}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-sm font-medium">{t.clientDisplayName}</div>
                  <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                    {t.assetModel && (
                      <span className="inline-flex items-center gap-1">
                        <Wrench className="h-3 w-3" />
                        {t.assetModel}
                        {t.assetSerialNumber && ` · ${t.assetSerialNumber}`}
                      </span>
                    )}
                  </div>
                  {(t.slaTargetAt || t.deadlineAt) && (
                    <div
                      className={cn(
                        'mt-1.5 inline-flex items-center gap-1 text-xs',
                        overdue ? 'text-destructive font-medium' : 'text-muted-foreground',
                      )}
                    >
                      {overdue ? (
                        <AlertOctagon className="h-3 w-3" />
                      ) : (
                        <Clock className="h-3 w-3" />
                      )}
                      {fmtDeadline(t.deadlineAt ?? t.slaTargetAt)}
                    </div>
                  )}
                </div>
                <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function fmtDeadline(d: Date | string | null): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  const now = Date.now();
  const diffMs = date.getTime() - now;
  const diffH = Math.round(diffMs / 3_600_000);
  if (diffH < 0) return `просрочено на ${Math.abs(diffH)} ч`;
  if (diffH < 24) return `осталось ${diffH} ч`;
  const days = Math.round(diffH / 24);
  return `осталось ${days} дн`;
}

function fmtTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

/** [start, end) — включительно start, исключая end. */
function isSameDay(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}
