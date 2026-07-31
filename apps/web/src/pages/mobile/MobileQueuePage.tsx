import { Link } from 'wouter';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  ChevronRight,
  AlertOctagon,
  AlertTriangle,
  Clock,
  Loader2,
  Package,
  Sparkles,
  Wrench,
  RefreshCw,
} from 'lucide-react';
import type { TicketStatus, TicketPriority } from '@erfolg/shared';
import { trpc, getTenantSubdomain } from '../../lib/trpc';
import { cn, getMondayOfThisWeek } from '../../lib/utils';
import { executeOrQueue } from '../../lib/offline/executor';
import { BLOCKED_REASON_META } from '../../lib/dictionaries/tickets';
import { assetIdentifierLine } from '../../lib/asset-identifiers';
import { PushToggle } from '../../components/PushToggle';
import {
  newAssignmentsCount,
  nextPageSize,
  readSeen,
  rebasedSeen,
  seenStorageKey,
  shownOfTotal,
} from '../../lib/queue-badge';

/** Сколько заявок подгружаем за раз и максимум, который отдаёт сервер (myList). */
const PAGE_STEP = 50;
const MAX_PAGE_SIZE = 500;

const ACTIVE_STATUSES: TicketStatus[] = [
  'received',
  'diagnostics',
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

type ReactAction = 'inwork' | 'ready' | 'part';

interface Props {
  engineerId: string;
}

/**
 * /m/queue — «Мой день» инженера: график на сегодня + провисшие с кнопками
 * быстрого ответа + очередь. Поллинг 30 сек. Понимает query-параметры от
 * web-push: ?react=<action>&ticket=<id> (кнопка в уведомлении) и ?nudge=<id>.
 */
export function MobileQueuePage({ engineerId }: Props) {
  const [tab, setTab] = useState<'active' | 'all'>('active');
  const utils = trpc.useUtils();
  const tenantSubdomain = getTenantSubdomain();

  // Растущее окно вместо накопления страниц: запрос всегда ОДИН, поллинг
  // перезабирает его целиком. Накопление страниц на экране с обновлением
  // каждые 30 секунд дало бы либо дубли, либо сброс до первой страницы.
  const [pageSize, setPageSize] = useState(PAGE_STEP);
  useEffect(() => {
    setPageSize(PAGE_STEP);
  }, [tab]);

  const list = trpc.tickets.myList.useQuery(
    {
      statuses: tab === 'active' ? ACTIVE_STATUSES : undefined,
      pageSize,
    },
    {
      // 30 сек поллинг — MVP-замена push-уведомлений. Только для активных:
      // «Все» — это архив, он не меняется каждые полминуты, а тянуть по 400
      // строк дважды в минуту незачем. Кнопка обновления и возврат в приложение
      // работают на обеих вкладках.
      refetchInterval: tab === 'active' ? 30_000 : false,
      refetchOnWindowFocus: true,
    },
  );

  // «Мой день»: мои активные заявки с полями доски (светофор/причина/дни простоя).
  const myTickets = trpc.tickets.myTickets.useQuery(undefined, {
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  // Stage 11 — расписание инженера: «Сегодня по графику» / «Завтра по графику».
  const weekStart = useMemo(() => getMondayOfThisWeek(), []);
  const schedule = trpc.tickets.myWeeklySchedule.useQuery(
    { weekStart },
    {
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  );

  const reactM = trpc.tickets.engineerReact.useMutation();
  const [busyTicket, setBusyTicket] = useState<string | null>(null);
  // «Ещё в работе» не сбрасывает дни простоя на доске (так задумано), поэтому
  // карточку после ответа прячем локально — иначе кнопка выглядит «неработающей».
  const [reactedIds, setReactedIds] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<{ kind: 'ok' | 'queued' | 'error'; text: string } | null>(
    null,
  );
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (t: NonNullable<typeof toast>) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const onReact = async (ticketId: string, action: ReactAction) => {
    setBusyTicket(ticketId);
    const result = await executeOrQueue(
      'tickets.engineerReact',
      { ticketId, action },
      (p) => reactM.mutateAsync(p),
      tenantSubdomain,
    );
    setBusyTicket(null);
    if (result.status === 'ok') {
      setReactedIds((prev) => new Set(prev).add(ticketId));
      await Promise.all([
        utils.tickets.myTickets.invalidate(),
        utils.tickets.myList.invalidate(),
      ]);
      showToast({ kind: 'ok', text: result.data.message });
    } else if (result.status === 'queued') {
      setReactedIds((prev) => new Set(prev).add(ticketId));
      showToast({ kind: 'queued', text: 'Нет связи — ответ сохранён и отправится сам' });
    } else {
      showToast({ kind: 'error', text: result.error.message });
    }
  };

  // Кнопка в web-push открывает /m/queue?react=<action>&ticket=<id> — выполняем сразу.
  // Клик по телу уведомления ведёт на /m/queue?nudge=<id> — просто чистим параметр
  // (провисшие и так наверху экрана).
  const handledPushAction = useRef(false);
  useEffect(() => {
    if (handledPushAction.current) return;
    handledPushAction.current = true;
    const params = new URLSearchParams(window.location.search);
    const action = params.get('react');
    const ticket = params.get('ticket');
    if ((action && ticket) || params.get('nudge')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    if (action && ticket && ['inwork', 'ready', 'part'].includes(action)) {
      void onReact(ticket, action as ReactAction);
    }
  }, []);

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

  // «Провисло»: без причины и давно без движения — те же пороги, что жёлтый на доске.
  // received исключаем: для непочатой заявки кнопки «готово/запчасть» бессмысленны
  // (и «Готово к выдаче» сервер для received не пускает).
  const stuckCards = useMemo(
    () =>
      (myTickets.data ?? [])
        .filter(
          (c) =>
            c.effectiveReason == null &&
            c.light !== 'green' &&
            !reactedIds.has(c.id) &&
            (c.status === 'diagnostics' || c.status === 'in_progress'),
        )
        .sort((a, b) => b.stuckDays - a.stuckDays),
    [myTickets.data, reactedIds],
  );
  /** Причина простоя по id заявки — чип в общем списке. */
  const reasonById = useMemo(() => {
    const m = new Map<string, { short: string; light: 'green' | 'yellow' | 'red' }>();
    for (const c of myTickets.data ?? []) {
      if (c.effectiveReason) {
        m.set(c.id, { short: BLOCKED_REASON_META[c.effectiveReason].short, light: c.light });
      }
    }
    return m;
  }, [myTickets.data]);

  const shownLabel = shownOfTotal(list.data?.items.length ?? 0, list.data?.total ?? 0);
  const canLoadMore = pageSize < MAX_PAGE_SIZE;

  const todayCount = scheduleHeader === 'Сегодня по графику' ? scheduleItems.length : 0;
  const inWorkCount = (myTickets.data ?? []).filter(
    (c) => c.status === 'in_progress' || c.status === 'diagnostics',
  ).length;

  // «Назначено новых» считаем от числа АКТИВНЫХ заявок (myTickets — отдельный
  // запрос без пагинации), а НЕ от total открытого списка. Иначе плашка
  // зависела бы от выбранной вкладки и от того, сколько страниц подгрузили:
  // отметив просмотренным архив на 480 заявок, инженер больше никогда не
  // увидел бы её на «Активных».
  const activeCount = myTickets.data?.length ?? null;
  const [seenCount, setSeenCount] = useState<number | null>(() =>
    readSeen(localStorage.getItem(seenStorageKey(engineerId))),
  );
  const newCount = useMemo(
    () => (activeCount === null ? 0 : newAssignmentsCount(activeCount, seenCount)),
    [activeCount, seenCount],
  );

  const markSeen = () => {
    if (activeCount === null) return;
    setSeenCount(activeCount);
    localStorage.setItem(seenStorageKey(engineerId), String(activeCount));
  };

  useEffect(() => {
    if (activeCount === null) return;
    // Первый заход: запоминаем текущее число молча, чтобы не показывать
    // «назначено новых: 12» человеку, который просто открыл приложение.
    if (seenCount === null) {
      setSeenCount(activeCount);
      localStorage.setItem(seenStorageKey(engineerId), String(activeCount));
      return;
    }
    // Заявки закрылись — опускаем отметку следом, иначе устаревший порог
    // «съест» следующие назначения и плашка снова замолчит.
    const rebased = rebasedSeen(activeCount, seenCount);
    if (rebased !== null) {
      setSeenCount(rebased);
      localStorage.setItem(seenStorageKey(engineerId), String(rebased));
    }
  }, [seenCount, activeCount, engineerId]);

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
          onClick={() => {
            void list.refetch();
            void myTickets.refetch();
          }}
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

      {(todayCount > 0 || inWorkCount > 0 || stuckCards.length > 0) && (
        <div className="bg-primary/8 border-primary/20 mx-3 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2">
          <Sparkles className="text-primary mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-foreground/80 text-xs leading-relaxed">
            Сегодня: {todayCount > 0 ? `выездов — ${todayCount}, ` : ''}в работе — {inWorkCount}
            {stuckCards.length > 0
              ? `, провисло — ${stuckCards.length} (ответьте кнопкой ниже)`
              : ''}
            .
          </p>
        </div>
      )}

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

      {stuckCards.length > 0 && (
        <section className="px-3 pt-3">
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle className="text-destructive h-4 w-4" />
            <h2 className="text-destructive text-sm font-semibold">
              Провисло — ответьте одной кнопкой
            </h2>
          </div>
          <ul className="space-y-2">
            {stuckCards.map((c) => (
              <li
                key={c.id}
                className="bg-destructive/5 border-destructive/25 rounded-lg border p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{c.ticketNumber}</span>
                  <span className="bg-destructive/10 text-destructive rounded-full px-2 py-0.5 text-[10px] font-medium">
                    стоит {c.stuckDays} дн
                  </span>
                </div>
                {c.assetModel && (
                  <div className="mt-1 text-sm font-medium">{c.assetModel}</div>
                )}
                <div className="text-destructive/80 mt-0.5 mb-2.5 text-xs">
                  причина не указана — что происходит?
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    disabled={busyTicket === c.id}
                    onClick={() => void onReact(c.id, 'inwork')}
                    className="bg-card hover:bg-muted/50 h-11 w-full rounded-lg border text-sm font-semibold transition disabled:opacity-50"
                  >
                    Ещё в работе
                  </button>
                  <button
                    type="button"
                    disabled={busyTicket === c.id}
                    onClick={() => void onReact(c.id, 'ready')}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 h-11 w-full rounded-lg text-sm font-semibold transition disabled:opacity-50"
                  >
                    Готово к выдаче
                  </button>
                  <button
                    type="button"
                    disabled={busyTicket === c.id}
                    onClick={() => void onReact(c.id, 'part')}
                    className="bg-accent text-accent-foreground hover:bg-accent/90 h-11 w-full rounded-lg text-sm font-semibold transition disabled:opacity-50"
                  >
                    Жду запчасть
                  </button>
                  <Link
                    href={`/m/tickets/${c.id}`}
                    className="text-primary py-1 text-center text-xs font-medium"
                  >
                    Другое — открыть заявку
                  </Link>
                </div>
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
          const reason = reasonById.get(t.id);
          // Серийный и/или инвентарный — у «инвентарных» заказчиков второй единственный.
          const assetIds = assetIdentifierLine({
            serialNumber: t.assetSerialNumber,
            inventoryNumber: t.assetInventoryNumber,
          });
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
                    {reason && (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-medium',
                          reason.light === 'red'
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-warning/15 text-warning',
                        )}
                      >
                        {reason.short}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-sm font-medium">{t.clientDisplayName}</div>
                  <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                    {t.assetModel && (
                      <span className="inline-flex items-center gap-1">
                        <Wrench className="h-3 w-3" />
                        {t.assetModel}
                        {assetIds && ` · ${assetIds}`}
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

      {/* Раньше список молча обрезался на 100 заявках: ни счётчика, ни кнопки.
          Инженер решал, что заявки нет, хотя она на следующей странице. */}
      {shownLabel && (
        <div className="flex flex-col items-center gap-2 px-3 pb-4">
          <div className="text-muted-foreground text-xs">{shownLabel}</div>
          {canLoadMore && (
            <button
              type="button"
              disabled={list.isFetching}
              onClick={() => setPageSize((n) => nextPageSize(n, PAGE_STEP, MAX_PAGE_SIZE))}
              className="bg-card hover:bg-muted/50 h-11 w-full rounded-lg border text-sm font-semibold transition disabled:opacity-50"
            >
              {list.isFetching ? 'Загружаем…' : 'Показать ещё'}
            </button>
          )}
        </div>
      )}

      {toast && (
        <div
          className={cn(
            'fixed inset-x-3 bottom-24 z-50 rounded-lg px-4 py-3 text-sm font-medium shadow-lg',
            toast.kind === 'ok' && 'bg-success text-white',
            toast.kind === 'queued' && 'bg-warning text-white',
            toast.kind === 'error' && 'bg-destructive text-white',
          )}
        >
          {toast.text}
        </div>
      )}
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
