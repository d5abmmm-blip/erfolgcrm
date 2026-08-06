/**
 * Stage 10'.J — Канбан-доска заявок.
 *
 * Дает диспетчеру обзор «где затык» одним взглядом и drag-and-drop между статусами.
 * Каждая колонка — статус (received → diagnostics → in_progress → act_pending).
 * closed/cancelled скрыты по умолчанию (опциональный чекбокс).
 *
 * Реализация:
 *   - КАЖДАЯ КОЛОНКА ГРУЗИТСЯ ОТДЕЛЬНЫМ ЗАПРОСОМ и листается своими страницами
 *     (COLUMN_PAGE_SIZE карточек). Раньше доска тянула всё ОДНИМ запросом с потолком
 *     в 200 строк: при «показать закрытые» архив (тысячи заявок) обрезался молча, а
 *     колонка росла вниз без конца. Постраничные колонки убирают потолок совсем и
 *     дают в шапке НАСТОЯЩЕЕ число заявок в статусе (а не «сколько влезло»).
 *   - Native HTML5 drag-and-drop, без внешних либ (react-dnd слишком тяжёл).
 *   - Live polling: refetchInterval=30_000 на каждую колонку.
 *   - Фильтр по инженеру (вкл. «без назначения» — считается на сервере, иначе счётчик
 *     и число страниц врали бы).
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  LayoutGrid,
  List,
  Package,
  Plus,
  Ticket as TicketIcon,
} from 'lucide-react';
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

/** Сколько карточек показывать в колонке до перелистывания (как в обычном списке заявок). */
const COLUMN_PAGE_SIZE = 25;

const POLL_INTERVAL_MS = 30_000;

/**
 * Легаси-статусы, снятые из потока («Смета»/«Согласование»). Колонку показываем ТОЛЬКО
 * если такие заявки реально есть, чтобы старые заявки не выпадали с доски беззвучно.
 * Раньше это делалось перебором фактически пришедших статусов — при постраничных колонках
 * так нельзя (мы больше не видим весь список), поэтому запрашиваем их явно и прячем пустые.
 */
const LEGACY_STATUSES: TicketStatus[] = ['estimate', 'approval'];

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

/** Что тащим: id + текущий статус (нужен, чтобы не «перекладывать» карточку саму в себя). */
interface DragState {
  id: string;
  status: TicketStatus;
}

export function TicketsKanbanPage() {
  const [showClosed, setShowClosed] = useState(false);
  const [engineerFilter, setEngineerFilter] = useState<string>(ENGINEER_ALL);
  const [toast, setToast] = useState<string | null>(null);
  /** Текущая страница каждой колонки (по статусу). Сбрасывается при смене фильтров. */
  const [pages, setPages] = useState<Partial<Record<TicketStatus, number>>>({});

  const engineers = trpc.users.list.useQuery({ onlyEngineers: true });
  const utils = trpc.useUtils();

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

  const engineerId =
    engineerFilter !== ENGINEER_ALL && engineerFilter !== ENGINEER_NONE
      ? engineerFilter
      : undefined;
  const unassigned = engineerFilter === ENGINEER_NONE ? true : undefined;

  // Сменили фильтр — начинаем каждую колонку с первой страницы.
  useEffect(() => {
    setPages({});
  }, [showClosed, engineerFilter]);

  const columns: TicketStatus[] = [
    ...ACTIVE_TICKET_STATUSES,
    ...(showClosed ? (['closed', 'cancelled'] as TicketStatus[]) : []),
    ...LEGACY_STATUSES,
  ];

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
            Перетащите карточку между колонками, чтобы перевести заявку в другой статус. Обновление
            каждые 30 секунд.
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
      </div>

      <KanbanBoard
        columns={columns}
        engineerId={engineerId}
        unassigned={unassigned}
        pages={pages}
        onPageChange={(status, page) => setPages((prev) => ({ ...prev, [status]: page }))}
        onMove={(id, status) => changeStatus.mutate({ id, status })}
      />

      {toast && (
        <div className="bg-destructive/10 border-destructive/30 text-destructive fixed bottom-4 right-4 z-50 rounded-md border px-3 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function KanbanBoard({
  columns,
  engineerId,
  unassigned,
  pages,
  onPageChange,
  onMove,
}: {
  columns: TicketStatus[];
  engineerId: string | undefined;
  unassigned: boolean | undefined;
  pages: Partial<Record<TicketStatus, number>>;
  onPageChange: (status: TicketStatus, page: number) => void;
  onMove: (id: string, status: TicketStatus) => void;
}) {
  const [dragged, setDragged] = useState<DragState | null>(null);
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
      {columns.map((col) => (
        <KanbanColumn
          key={col}
          status={col}
          engineerId={engineerId}
          unassigned={unassigned}
          page={pages[col] ?? 1}
          onPageChange={(p) => onPageChange(col, p)}
          // Легаси-колонку («Смета»/«Согласование») прячем, если таких заявок нет.
          hideWhenEmpty={LEGACY_STATUSES.includes(col)}
          dragged={dragged}
          setDragged={setDragged}
          isOver={overCol === col}
          setOverCol={setOverCol}
          onMove={onMove}
        />
      ))}
    </div>
  );
}

function KanbanColumn({
  status,
  engineerId,
  unassigned,
  page,
  onPageChange,
  hideWhenEmpty,
  dragged,
  setDragged,
  isOver,
  setOverCol,
  onMove,
}: {
  status: TicketStatus;
  engineerId: string | undefined;
  unassigned: boolean | undefined;
  page: number;
  onPageChange: (page: number) => void;
  hideWhenEmpty: boolean;
  dragged: DragState | null;
  setDragged: (d: DragState | null) => void;
  isOver: boolean;
  setOverCol: (s: TicketStatus | null) => void;
  onMove: (id: string, status: TicketStatus) => void;
}) {
  const q = trpc.tickets.list.useQuery(
    {
      statuses: [status],
      engineerId,
      unassigned,
      // Срочные — вверху своей колонки.
      sort: 'priority',
      page,
      pageSize: COLUMN_PAGE_SIZE,
    },
    { refetchInterval: POLL_INTERVAL_MS, refetchOnWindowFocus: true },
  );

  const items = (q.data?.items ?? []) as TicketRow[];
  const total = q.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / COLUMN_PAGE_SIZE));

  // Заявку перетащили из этой колонки — страница могла «схлопнуться». Не зависаем на пустой.
  useEffect(() => {
    if (total > 0 && page > pageCount) onPageChange(pageCount);
  }, [total, page, pageCount, onPageChange]);

  // Легаси-статусы: колонки нет, пока в ней нечего показывать.
  if (hideWhenEmpty && !q.isLoading && total === 0) return null;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOverCol(status);
      }}
      onDragLeave={() => setOverCol(null)}
      onDrop={(e) => {
        e.preventDefault();
        setOverCol(null);
        const id = e.dataTransfer.getData('text/plain') || dragged?.id;
        if (!id) return;
        // Статус тащим вместе с карточкой: у колонки больше нет общего списка заявок.
        const from = dragged?.status;
        if (from === status) return;
        onMove(id, status);
      }}
      className={cn(
        'bg-card flex min-h-[120px] flex-col gap-2 rounded-lg border p-2 transition',
        isOver && 'border-primary ring-primary/30 ring-2',
      )}
    >
      <div className="flex items-center justify-between gap-1 px-1">
        <span className="text-xs font-medium uppercase tracking-wide">
          {TICKET_STATUS_META[status].label}
        </span>
        {/* Настоящее число заявок в статусе, а не «сколько влезло на страницу». */}
        <span className="text-muted-foreground text-xs tabular-nums" title="Всего в статусе">
          {q.isLoading ? '…' : total}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {q.isLoading ? (
          <div className="text-muted-foreground rounded-md border border-dashed p-3 text-center text-xs">
            загрузка…
          </div>
        ) : q.error ? (
          <div className="text-destructive rounded-md border border-dashed p-3 text-center text-xs">
            ошибка
          </div>
        ) : items.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed p-3 text-center text-xs">
            пусто
          </div>
        ) : (
          items.map((t) => (
            <KanbanCard
              key={t.id}
              ticket={t}
              onDragStart={(e) => {
                setDragged({ id: t.id, status: t.status });
                e.dataTransfer.setData('text/plain', t.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                setDragged(null);
                setOverCol(null);
              }}
            />
          ))
        )}
      </div>

      {/* Подвал колонки. Показываем ВСЕГДА (когда есть что показывать), даже если страница
          одна: иначе низ колонки просто обрывается и непонятно — это конец или обрезка. */}
      {total > 0 && !q.isLoading && (
        <div className="mt-auto space-y-1 border-t pt-1.5">
          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-1">
              <PagerButton
                label="Предыдущая страница"
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </PagerButton>
              <span className="text-muted-foreground text-[10px] tabular-nums">
                {page} / {pageCount}
              </span>
              <PagerButton
                label="Следующая страница"
                disabled={page >= pageCount}
                onClick={() => onPageChange(page + 1)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </PagerButton>
            </div>
          )}
          <div className="text-muted-foreground text-center text-[10px] tabular-nums">
            показано {items.length} из {total}
          </div>
        </div>
      )}
    </div>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-6 w-6 items-center justify-center rounded transition disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
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
  const options: Array<{ v: 'table' | 'kanban'; href: string; icon: typeof List; label: string }> =
    [
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
