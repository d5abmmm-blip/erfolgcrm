/**
 * Stage 10'.J — Канбан-доска заявок.
 *
 * Дает диспетчеру обзор «где затык» одним взглядом и drag-and-drop между статусами.
 * Каждая колонка — статус (received → diagnostics → in_progress → act_pending).
 * closed/cancelled скрыты по умолчанию (опциональный чекбокс).
 *
 * Реализация:
 *   - Native HTML5 drag-and-drop, без внешних либ (react-dnd слишком тяжёл).
 *   - Optimistic update: при drop сразу применяем status в кэше; на ошибке откатываем + toast.
 *   - Live polling: refetchInterval=30_000.
 *   - Фильтр по инженеру (вкл. «без назначения»).
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { Clock, LayoutGrid, List, Package, Plus, Ticket as TicketIcon } from 'lucide-react';
import type { TicketStatus, TicketPriority } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  TICKET_STATUS_META,
  TICKET_PRIORITY_META,
  ACTIVE_TICKET_STATUSES,
  isTicketStale,
} from '../lib/dictionaries';
import { StatusBadge } from '../components/ui/StatusBadge';

const ENGINEER_ALL = '__all__';
const ENGINEER_NONE = '__none__';

interface TicketRow {
  id: string;
  ticketNumber: string;
  status: TicketStatus;
  priority: TicketPriority;
  clientId: string;
  clientDisplayName: string;
  assetId: string | null;
  assetModel: string | null;
  assetSerialNumber: string | null;
  assignedEngineerId: string | null;
  assignedEngineerName: string | null;
  slaTargetAt: Date | null;
  receivedAt: Date;
  waitingForPart: boolean;
  /** Полных суток без активности (max(updated_at, последнее ticket_event)) — из API. */
  idleDays: number;
}

const POLL_INTERVAL_MS = 30_000;

export function TicketsKanbanPage() {
  const [showClosed, setShowClosed] = useState(false);
  const [engineerFilter, setEngineerFilter] = useState<string>(ENGINEER_ALL);
  const [toast, setToast] = useState<string | null>(null);

  const engineers = trpc.users.list.useQuery({ onlyEngineers: true });
  const utils = trpc.useUtils();

  const list = trpc.tickets.list.useQuery(
    {
      pageSize: 200,
      statuses: showClosed ? undefined : [...ACTIVE_TICKET_STATUSES],
      engineerId:
        engineerFilter !== ENGINEER_ALL && engineerFilter !== ENGINEER_NONE
          ? engineerFilter
          : undefined,
    },
    { refetchInterval: POLL_INTERVAL_MS, refetchOnWindowFocus: true },
  );

  const changeStatus = trpc.tickets.changeStatus.useMutation({
    onSuccess: async () => {
      await utils.tickets.list.invalidate();
    },
    onError: (err) => {
      setToast(err.message ?? 'Ошибка перевода статуса');
      setTimeout(() => setToast(null), 4000);
      void utils.tickets.list.invalidate();
    },
  });

  const allItems = (list.data?.items ?? []) as TicketRow[];
  // Локальный фильтр «без инженера» — на стороне клиента (tickets.list не принимает null).
  const items =
    engineerFilter === ENGINEER_NONE
      ? allItems.filter((t) => !t.assignedEngineerId)
      : allItems;

  const cols: TicketStatus[] = showClosed
    ? [...ACTIVE_TICKET_STATUSES, 'closed', 'cancelled']
    : [...ACTIVE_TICKET_STATUSES];

  // Легаси/нестандартные статусы (например снятые из потока «Смета»/«Согласование»),
  // которые бэкенд всё же вернул: показываем отдельными колонками, чтобы такие заявки
  // не выпадали с доски беззвучно. Актуально при «показать закрытые» — иначе бэкенд
  // фильтрует список по активным статусам, и легаси-заявки в него не попадают.
  const extraCols: TicketStatus[] = [...new Set(items.map((t) => t.status))].filter(
    (s) => !cols.includes(s),
  );
  const boardCols: TicketStatus[] = [...cols, ...extraCols];

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <TicketIcon className="h-3.5 w-3.5" />
            Заявки
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Канбан</h1>
          <p className="text-muted-foreground text-sm">
            Перетащите карточку между колонками, чтобы перевести заявку в другой статус.
            Обновление каждые 30 секунд.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewToggleNav current="kanban" />
          <Link
            href="/tickets/new"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Новая заявка
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-muted-foreground text-xs">Инженер:</label>
        <select
          value={engineerFilter}
          onChange={(e) => setEngineerFilter(e.target.value)}
          className="bg-background rounded-md border px-2 py-1 text-sm"
        >
          <option value={ENGINEER_ALL}>Все</option>
          <option value={ENGINEER_NONE}>Без назначения</option>
          {(engineers.data ?? [])
            .filter((u) => u.role === 'engineer')
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
        </select>

        <label className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
            className="border-input h-3.5 w-3.5 rounded"
          />
          закрытые/отменённые
        </label>

        {list.isFetching && !list.isLoading && (
          <span className="text-muted-foreground text-xs">обновляю…</span>
        )}
      </div>

      {list.isLoading ? (
        <div className="text-muted-foreground p-8 text-center text-sm">Загрузка…</div>
      ) : list.error ? (
        <div className="text-destructive p-6 text-sm">Ошибка: {list.error.message}</div>
      ) : (
        <KanbanBoard
          items={items}
          columns={boardCols}
          onMove={(id, status) => changeStatus.mutate({ id, status })}
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

function KanbanBoard({
  items,
  columns,
  onMove,
}: {
  items: TicketRow[];
  columns: TicketStatus[];
  onMove: (id: string, status: TicketStatus) => void;
}) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TicketStatus | null>(null);

  return (
    <div
      className={cn(
        'grid gap-3',
        columns.length <= 6
          ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6'
          : 'grid-cols-2 md:grid-cols-4 lg:grid-cols-8',
      )}
    >
      {columns.map((col) => {
        const colItems = items.filter((t) => t.status === col);
        return (
          <div
            key={col}
            onDragOver={(e) => {
              e.preventDefault();
              setOverCol(col);
            }}
            onDragLeave={() => setOverCol((c) => (c === col ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              setOverCol(null);
              const id = e.dataTransfer.getData('text/plain') || draggedId;
              if (!id) return;
              const t = items.find((x) => x.id === id);
              if (!t || t.status === col) return;
              onMove(id, col);
            }}
            className={cn(
              'bg-card flex min-h-[120px] flex-col gap-2 rounded-lg border p-2 transition',
              overCol === col && 'border-primary ring-2 ring-primary/30',
            )}
          >
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-medium uppercase tracking-wide">
                {TICKET_STATUS_META[col].label}
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {colItems.length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {colItems.length === 0 ? (
                <div className="text-muted-foreground rounded-md border border-dashed p-3 text-center text-xs">
                  пусто
                </div>
              ) : (
                colItems.map((t) => (
                  <KanbanCard
                    key={t.id}
                    ticket={t}
                    onDragStart={(e) => {
                      setDraggedId(t.id);
                      e.dataTransfer.setData('text/plain', t.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setOverCol(null);
                    }}
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

function KanbanCard({
  ticket: t,
  onDragStart,
  onDragEnd,
}: {
  ticket: TicketRow;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  // «Висит» = открытая заявка без активности дольше порога (idleDays из API,
  // та же семантика, что в списке и у AI-инструмента list_aged_tickets).
  const stuck = isTicketStale(t.status, t.idleDays);
  return (
    <Link
      href={`/tickets/${t.id}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'bg-background hover:border-primary/40 cursor-grab rounded-md border p-2 text-xs shadow-sm transition active:cursor-grabbing',
        stuck && 'border-destructive/50',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono font-medium">{t.ticketNumber}</span>
        <PriorityBadge priority={t.priority} />
      </div>
      <div className="mt-1 truncate font-medium" title={t.clientDisplayName}>
        {t.clientDisplayName}
      </div>
      <div className="text-muted-foreground mt-0.5 truncate" title={t.assetModel ?? ''}>
        {t.assetModel ?? '—'}
      </div>
      {(t.waitingForPart || stuck) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {t.waitingForPart && (
            <span className="bg-warning/15 text-warning inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
              <Package className="h-3 w-3" />
              ждём запчасть
            </span>
          )}
          {stuck && (
            <span
              className="bg-destructive/10 text-destructive inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
              title="Открытая заявка давно без активности"
            >
              <Clock className="h-3 w-3" />
              висит {t.idleDays} дн.
            </span>
          )}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-muted-foreground truncate">
          {t.assignedEngineerName ?? 'не назначен'}
        </span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] tabular-nums',
            stuck ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground',
          )}
          title="Дней без активности"
        >
          {t.idleDays}д
        </span>
      </div>
    </Link>
  );
}

function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const v = TICKET_PRIORITY_META[priority];
  return (
    <StatusBadge variant={v.variant} compact>
      {v.label}
    </StatusBadge>
  );
}

export function ViewToggleNav({ current }: { current: 'table' | 'kanban' }) {
  const options: Array<{ v: 'table' | 'kanban'; href: string; icon: typeof List; label: string }> = [
    { v: 'table', href: '/tickets', icon: List, label: 'Список' },
    { v: 'kanban', href: '/tickets/kanban', icon: LayoutGrid, label: 'Канбан' },
  ];
  return (
    <div className="bg-secondary inline-flex rounded-md p-0.5">
      {options.map(({ v, href, icon: Icon, label }) => (
        <Link
          key={v}
          href={href}
          className={cn(
            'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition',
            current === v
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </Link>
      ))}
    </div>
  );
}
