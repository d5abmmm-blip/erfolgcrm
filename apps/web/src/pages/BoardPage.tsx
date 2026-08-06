/**
 * Доска «Кто чем занят / Почему стоит».
 *
 * Один экран, два вида поверх одного запроса tickets.board:
 *   • «По инженеру» — колонка на каждого инженера (+ «Не назначен»); видно кто перегружен.
 *   • «По причине простоя» — колонки причин; в карточке «стоит N дней» + кто отвечает.
 * Светофор на карточке: зелёный (движется) / жёлтый (ждёт) / красный (застряло/просрочка).
 * Причину простоя менеджер ставит прямо на карточке (select) — setBlockedReason.
 *
 * Живое обновление раз в 30 секунд. Тяжёлый детальный Гант — отдельно на /schedule.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import {
  AlertTriangle,
  Calendar,
  Clock,
  LayoutGrid,
  Package,
  PhoneCall,
  Plane,
  Plus,
  Users,
} from 'lucide-react';
import type { TicketBlockedReason, TicketStatus, TicketPriority } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  TICKET_STATUS_META,
  TICKET_PRIORITY_META,
  BLOCKED_REASON_META,
  BLOCKED_REASON_COLUMNS,
  SETTABLE_BLOCKED_REASONS,
  TRAFFIC_LIGHT_DOT,
} from '../lib/dictionaries';
import { StatusBadge } from '../components/ui/StatusBadge';

type BoardView = 'engineer' | 'reason';
type AvailabilityKind = 'day_off' | 'vacation' | 'onsite';
const POLL_INTERVAL_MS = 30_000;
const UNASSIGNED = '__none__';

const AVAILABILITY_LABEL: Record<AvailabilityKind, string> = {
  day_off: 'выходной',
  vacation: 'отпуск',
  onsite: 'на выезде',
};

type BoardCard = {
  id: string;
  ticketNumber: string;
  status: TicketStatus;
  priority: TicketPriority;
  clientDisplayName: string;
  assetModel: string | null;
  deviceType: string | null;
  assignedEngineerId: string | null;
  assignedEngineerName: string | null;
  waitingForPart: boolean;
  waitingForPartNote: string | null;
  blockedReason: TicketBlockedReason | null;
  effectiveReason: TicketBlockedReason | null;
  stuckDays: number;
  light: 'green' | 'yellow' | 'red';
};

export function BoardPage() {
  const [view, setView] = useState<BoardView>('engineer');
  const [toast, setToast] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const board = trpc.tickets.board.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  const engineersQ = trpc.users.list.useQuery({ onlyEngineers: true });
  const skillsQ = trpc.engineerProfile.listSkills.useQuery(undefined, { staleTime: 5 * 60_000 });
  const availQ = trpc.engineerProfile.availabilityToday.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  const skillsByEngineer = new Map<string, string[]>();
  for (const s of skillsQ.data ?? []) {
    const arr = skillsByEngineer.get(s.userId) ?? [];
    arr.push(s.deviceType);
    skillsByEngineer.set(s.userId, arr);
  }
  const availByEngineer = new Map<string, AvailabilityKind>();
  for (const a of availQ.data ?? []) availByEngineer.set(a.userId, a.kind);

  const setReason = trpc.tickets.setBlockedReason.useMutation({
    onSuccess: () => utils.tickets.board.invalidate(),
    onError: (err) => {
      setToast(err.message ?? 'Не удалось изменить причину простоя');
      setTimeout(() => setToast(null), 4000);
    },
  });

  const items = (board.data ?? []) as BoardCard[];
  const engineers = (engineersQ.data ?? []).filter((u) => u.role === 'engineer');

  const stuck = items.filter((t) => t.light === 'red').length;
  const waiting = items.filter((t) => t.light === 'yellow').length;
  const ready = items.filter((t) => t.effectiveReason === 'ready_for_pickup').length;

  return (
    <div className="mx-auto max-w-[110rem] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <LayoutGrid className="h-3.5 w-3.5" />
            Доска
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Кто чем занят и почему стоит</h1>
          <p className="text-muted-foreground text-sm">
            Активных {items.length} · <span className="text-destructive">застряло {stuck}</span> ·{' '}
            <span className="text-warning">ждут {waiting}</span> · готово к выдаче {ready}.
            Обновление каждые 30 секунд.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewToggle view={view} onChange={setView} />
          <Link
            href="/schedule"
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-sm transition"
            title="Детальный график по часам"
          >
            <Calendar className="h-4 w-4" />
            График
          </Link>
          <Link
            href="/tickets/new"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Новая заявка
          </Link>
        </div>
      </div>

      <Legend fetching={board.isFetching && !board.isLoading} />

      {board.isLoading ? (
        <div className="text-muted-foreground p-8 text-center text-sm">Загрузка…</div>
      ) : board.error ? (
        <div className="text-destructive p-6 text-sm">Ошибка: {board.error.message}</div>
      ) : view === 'engineer' ? (
        <EngineerView
          items={items}
          engineers={engineers.map((e) => ({ id: e.id, fullName: e.fullName }))}
          skillsByEngineer={skillsByEngineer}
          availByEngineer={availByEngineer}
          onSetReason={(ticketId, reason) => setReason.mutate({ ticketId, reason })}
        />
      ) : (
        <ReasonView
          items={items}
          onSetReason={(ticketId, reason) => setReason.mutate({ ticketId, reason })}
        />
      )}

      {toast && (
        <div className="bg-destructive/10 border-destructive/30 text-destructive fixed bottom-4 right-4 z-50 rounded-md border px-3 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: BoardView; onChange: (v: BoardView) => void }) {
  const options: Array<{ v: BoardView; icon: typeof Users; label: string }> = [
    { v: 'engineer', icon: Users, label: 'По инженеру' },
    { v: 'reason', icon: Clock, label: 'По причине простоя' },
  ];
  return (
    <div className="bg-secondary inline-flex rounded-md p-0.5">
      {options.map(({ v, icon: Icon, label }) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition',
            view === v
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function Legend({ fetching }: { fetching: boolean }) {
  const dots: Array<{ light: 'green' | 'yellow' | 'red'; label: string }> = [
    { light: 'green', label: 'движется' },
    { light: 'yellow', label: 'ждёт' },
    { light: 'red', label: 'застряло / просрочка' },
  ];
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-4 text-xs">
      {dots.map((d) => (
        <span key={d.light} className="inline-flex items-center gap-1.5">
          <span className={cn('h-2.5 w-2.5 rounded-full', TRAFFIC_LIGHT_DOT[d.light])} />
          {d.label}
        </span>
      ))}
      {fetching && <span className="ml-auto">обновляю…</span>}
    </div>
  );
}

/* ───────────────────────── Вид «По инженеру» ───────────────────────── */

function EngineerView({
  items,
  engineers,
  skillsByEngineer,
  availByEngineer,
  onSetReason,
}: {
  items: BoardCard[];
  engineers: Array<{ id: string; fullName: string }>;
  skillsByEngineer: Map<string, string[]>;
  availByEngineer: Map<string, AvailabilityKind>;
  onSetReason: (ticketId: string, reason: TicketBlockedReason | null) => void;
}) {
  const byEngineer = new Map<string, BoardCard[]>();
  const unassigned: BoardCard[] = [];
  for (const t of items) {
    if (t.assignedEngineerId) {
      const arr = byEngineer.get(t.assignedEngineerId) ?? [];
      arr.push(t);
      byEngineer.set(t.assignedEngineerId, arr);
    } else {
      unassigned.push(t);
    }
  }

  const columns: Array<{ key: string; name: string; cards: BoardCard[] }> = [];
  const known = new Set<string>();
  for (const e of engineers) {
    known.add(e.id);
    columns.push({ key: e.id, name: e.fullName, cards: byEngineer.get(e.id) ?? [] });
  }
  // Инженер, которого нет в списке (напр. деактивирован), но на нём висит заявка.
  for (const t of items) {
    if (t.assignedEngineerId && !known.has(t.assignedEngineerId)) {
      known.add(t.assignedEngineerId);
      columns.push({
        key: t.assignedEngineerId,
        name: t.assignedEngineerName ?? '—',
        cards: byEngineer.get(t.assignedEngineerId) ?? [],
      });
    }
  }
  // Порядок колонок — по загрузке: самый занятой инженер первым, дальше по убыванию.
  // При равенстве — по алфавиту, чтобы порядок не «прыгал» между автообновлениями.
  columns.sort((a, b) => b.cards.length - a.cards.length || a.name.localeCompare(b.name, 'ru'));
  // «Не назначен» всегда в конце — это не инженер, а очередь на распределение.
  columns.push({ key: UNASSIGNED, name: 'Не назначен', cards: unassigned });

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((col) => {
        const isEngineer = col.key !== UNASSIGNED;
        const overload = isEngineer && col.cards.length >= 3;
        const avail = isEngineer ? availByEngineer.get(col.key) : undefined;
        const skills = isEngineer ? (skillsByEngineer.get(col.key) ?? []) : [];
        return (
          <div key={col.key} className="bg-muted/40 flex w-72 shrink-0 flex-col rounded-xl p-2.5">
            <div className="mb-1 flex items-center justify-between px-1">
              <span
                className={cn(
                  'truncate text-sm font-medium',
                  col.key === UNASSIGNED && 'text-muted-foreground',
                )}
                title={col.name}
              >
                {col.name}
              </span>
              <span
                className={cn(
                  'ml-2 inline-flex min-w-6 justify-center rounded-full border px-1.5 py-0.5 text-xs tabular-nums',
                  overload
                    ? 'bg-warning/15 text-warning border-warning/30'
                    : 'bg-background text-muted-foreground',
                )}
                title={overload ? 'Загружен' : undefined}
              >
                {col.cards.length}
              </span>
            </div>
            {(avail || skills.length > 0) && (
              <div className="mb-2 flex flex-wrap gap-1 px-1">
                {avail && (
                  <span className="bg-secondary text-muted-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]">
                    <Plane className="h-3 w-3" />
                    {AVAILABILITY_LABEL[avail]}
                  </span>
                )}
                {skills.slice(0, 4).map((s) => (
                  <span
                    key={s}
                    className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px]"
                    title={s}
                  >
                    {s}
                  </span>
                ))}
                {skills.length > 4 && (
                  <span className="text-muted-foreground text-[10px]">+{skills.length - 4}</span>
                )}
              </div>
            )}
            <div className="flex flex-col gap-2">
              {col.cards.length === 0 ? (
                <div className="text-muted-foreground rounded-md border border-dashed p-3 text-center text-xs">
                  нет заявок
                </div>
              ) : (
                col.cards.map((t) => (
                  <BoardCardView
                    key={t.id}
                    card={t}
                    showEngineer={false}
                    onSetReason={onSetReason}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── Вид «По причине простоя» ───────────────────────── */

const UNSPECIFIED_COL = '__unspecified__';

function ReasonView({
  items,
  onSetReason,
}: {
  items: BoardCard[];
  onSetReason: (ticketId: string, reason: TicketBlockedReason | null) => void;
}) {
  const byReason = new Map<string, BoardCard[]>();
  const push = (key: string, t: BoardCard) => {
    const arr = byReason.get(key) ?? [];
    arr.push(t);
    byReason.set(key, arr);
  };
  for (const t of items) {
    if (t.effectiveReason) push(t.effectiveReason, t);
    // Застряла/ждёт, но причина не проставлена и из статуса не выводится — отдельная колонка,
    // чтобы менеджер увидел и указал причину (иначе «почему стоит» теряет эти заявки).
    else if (t.light !== 'green') push(UNSPECIFIED_COL, t);
    // else «движется» — не в колонках причин.
  }

  const columns: Array<{ key: string; label: string; kind: 'unspec' | 'ready' | 'reason' }> = [];
  if ((byReason.get(UNSPECIFIED_COL)?.length ?? 0) > 0) {
    columns.push({ key: UNSPECIFIED_COL, label: 'Стоит — причина не указана', kind: 'unspec' });
  }
  for (const r of BLOCKED_REASON_COLUMNS) {
    if ((byReason.get(r)?.length ?? 0) > 0) {
      columns.push({
        key: r,
        label: BLOCKED_REASON_META[r].label,
        kind: r === 'ready_for_pickup' ? 'ready' : 'reason',
      });
    }
  }

  if (columns.length === 0) {
    return (
      <div className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
        Простаивающих заявок нет — всё в движении.
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((col) => {
        const cards = byReason.get(col.key) ?? [];
        return (
          <div key={col.key} className="bg-muted/40 flex w-72 shrink-0 flex-col rounded-xl p-2.5">
            <div className="mb-2 flex items-center gap-2 px-1">
              {col.kind === 'ready' ? (
                <PhoneCall className="text-success h-3.5 w-3.5 shrink-0" />
              ) : col.kind === 'unspec' ? (
                <AlertTriangle className="text-destructive h-3.5 w-3.5 shrink-0" />
              ) : (
                <Clock className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate text-sm font-medium" title={col.label}>
                {col.label}
              </span>
              <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                {cards.length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {cards.map((t) => (
                <BoardCardView key={t.id} card={t} showEngineer onSetReason={onSetReason} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── Карточка заявки ───────────────────────── */

function BoardCardView({
  card: t,
  showEngineer,
  onSetReason,
}: {
  card: BoardCard;
  showEngineer: boolean;
  onSetReason: (ticketId: string, reason: TicketBlockedReason | null) => void;
}) {
  const prio = TICKET_PRIORITY_META[t.priority];
  const showPrio = t.priority === 'high' || t.priority === 'urgent';
  return (
    <div
      className={cn(
        'bg-background rounded-lg border p-2.5 text-xs shadow-sm transition',
        t.light === 'red' && 'border-destructive/40',
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-full', TRAFFIC_LIGHT_DOT[t.light])}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <Link
            href={`/tickets/${t.id}`}
            className="hover:text-primary block truncate font-medium"
            title={t.assetModel ?? t.clientDisplayName}
          >
            {t.assetModel ?? t.clientDisplayName}
          </Link>
          <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <span className="font-mono">{t.ticketNumber}</span>
            {t.deviceType && <span className="truncate">· {t.deviceType}</span>}
          </div>
        </div>
        {showPrio && (
          <StatusBadge variant={prio.variant} compact>
            {prio.label}
          </StatusBadge>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5">
          {TICKET_STATUS_META[t.status].label}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5',
            t.light === 'red' ? 'text-destructive' : 'text-muted-foreground',
          )}
          title="Сколько стоит без движения"
        >
          <Clock className="h-3 w-3" />
          {t.stuckDays} дн
        </span>
        {t.waitingForPart && (
          <span className="bg-warning/15 text-warning inline-flex items-center gap-1 rounded px-1.5 py-0.5">
            <Package className="h-3 w-3" />
            запчасть
          </span>
        )}
      </div>

      {t.waitingForPartNote && (
        <div className="text-muted-foreground mt-1 truncate" title={t.waitingForPartNote}>
          {t.waitingForPartNote}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        {showEngineer && (
          <span className="text-muted-foreground truncate" title={t.assignedEngineerName ?? ''}>
            {t.assignedEngineerName ?? 'не назначен'}
          </span>
        )}
        <ReasonSelect
          card={t}
          onSetReason={onSetReason}
          className={showEngineer ? 'ml-auto' : 'w-full'}
        />
      </div>
    </div>
  );
}

/** Компактный выбор причины простоя прямо на карточке. */
function ReasonSelect({
  card: t,
  onSetReason,
  className,
}: {
  card: BoardCard;
  onSetReason: (ticketId: string, reason: TicketBlockedReason | null) => void;
  className?: string;
}) {
  // В select показываем только вручную-задаваемые причины; текущая (если ручная) — выбрана.
  const current =
    t.blockedReason && SETTABLE_BLOCKED_REASONS.includes(t.blockedReason) ? t.blockedReason : '';
  return (
    <select
      value={current}
      onChange={(e) => {
        const v = e.target.value;
        onSetReason(t.id, v ? (v as TicketBlockedReason) : null);
      }}
      onClick={(e) => e.stopPropagation()}
      title="Причина простоя"
      className={cn(
        'bg-background text-muted-foreground max-w-[9.5rem] rounded border px-1.5 py-1 text-[11px]',
        className,
      )}
    >
      <option value="">движется / по статусу</option>
      {SETTABLE_BLOCKED_REASONS.map((r) => (
        <option key={r} value={r}>
          {BLOCKED_REASON_META[r].short}
        </option>
      ))}
    </select>
  );
}
