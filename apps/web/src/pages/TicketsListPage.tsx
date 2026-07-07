import { useState } from 'react';
import { Link } from 'wouter';
import {
  Clock,
  Package,
  Plus,
  Search,
  Ticket as TicketIcon,
  LayoutGrid,
  List,
} from 'lucide-react';
import type { TicketStatus, TicketPriority } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { useDebounce } from '../lib/hooks/useDebounce';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { TICKET_STATUS_META, TICKET_PRIORITY_META, isTicketStale } from '../lib/dictionaries';

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
  idleDays: number;
}

const PAGE_SIZE = 25;

export function TicketsListPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [statuses, setStatuses] = useState<TicketStatus[]>([]);
  const [onlyWaitingPart, setOnlyWaitingPart] = useState(false);
  const [page, setPage] = useState(1);

  const list = trpc.tickets.list.useQuery({
    search: debounced || undefined,
    statuses: statuses.length > 0 ? statuses : undefined,
    waitingForPart: onlyWaitingPart ? true : undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const items = (list.data?.items ?? []) as TicketRow[];
  const total = list.data?.total ?? 0;

  const toggleStatus = (s: TicketStatus) => {
    setStatuses((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
    setPage(1);
  };

  const columns: Column<TicketRow>[] = [
    {
      key: 'ticketNumber',
      label: '№',
      render: (t) => (
        <div className="flex flex-col gap-1">
          <Link
            href={`/tickets/${t.id}`}
            className="text-foreground hover:text-primary font-mono font-medium"
          >
            {t.ticketNumber}
          </Link>
          {t.waitingForPart && <WaitingPartBadge />}
          {isTicketStale(t.status, t.idleDays) && <StaleBadge days={t.idleDays} />}
        </div>
      ),
    },
    {
      key: 'client',
      label: 'Клиент',
      render: (t) => (
        <Link
          href={`/clients/${t.clientId}`}
          className="text-muted-foreground hover:text-primary"
        >
          {t.clientDisplayName}
        </Link>
      ),
    },
    {
      key: 'asset',
      label: 'Техника',
      render: (t) =>
        t.assetModel ? (
          <div>
            <Link
              href={`/assets/${t.assetId}`}
              className="text-foreground hover:text-primary"
            >
              {t.assetModel}
            </Link>
            {t.assetSerialNumber && (
              <div className="text-muted-foreground font-mono text-xs">
                s/n {t.assetSerialNumber}
              </div>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Статус',
      render: (t) => {
        const meta = TICKET_STATUS_META[t.status];
        return <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>;
      },
    },
    {
      key: 'priority',
      label: 'Приоритет',
      render: (t) => {
        const meta = TICKET_PRIORITY_META[t.priority];
        return (
          <StatusBadge variant={meta.variant} compact>
            {meta.label}
          </StatusBadge>
        );
      },
    },
    {
      key: 'engineer',
      label: 'Инженер',
      className: 'text-muted-foreground text-xs',
      render: (t) => t.assignedEngineerName ?? '—',
    },
    {
      key: 'receivedAt',
      label: 'Получено',
      className: 'text-muted-foreground text-xs tabular-nums',
      render: (t) => formatDate(t.receivedAt),
    },
    {
      key: 'sla',
      label: 'SLA',
      render: (t) => <SlaBadge target={t.slaTargetAt} status={t.status} />,
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <TicketIcon className="h-3.5 w-3.5" />
            Заявки
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Все заявки</h1>
          <p className="text-muted-foreground text-sm">
            Поток заявок от клиентов: приём, диагностика, ремонт, акт
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle current="table" />
          <Link
            href="/tickets/new"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Новая заявка
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="T-номер, клиент, модель техники, симптом…"
            className="bg-background w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {(Object.keys(TICKET_STATUS_META) as TicketStatus[]).map((s) => {
          const active = statuses.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStatus(s)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs transition',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-foreground/30',
              )}
            >
              {TICKET_STATUS_META[s].label}
            </button>
          );
        })}
        {statuses.length > 0 && (
          <button
            type="button"
            onClick={() => setStatuses([])}
            className="text-muted-foreground hover:text-foreground rounded-full px-2 py-0.5 text-xs"
          >
            сбросить
          </button>
        )}

        <span className="bg-border mx-1 h-4 w-px self-center" aria-hidden />

        <button
          type="button"
          onClick={() => {
            setOnlyWaitingPart((v) => !v);
            setPage(1);
          }}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition',
            onlyWaitingPart
              ? 'border-warning bg-warning/10 text-warning'
              : 'border-border text-muted-foreground hover:border-foreground/30',
          )}
        >
          <Package className="h-3 w-3" />
          Только ждущие запчасть
        </button>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Заявок нет"
        rowKey={(t) => t.id}
      />

      <Pagination
        page={page}
        total={total}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />
    </div>
  );
}

function ViewToggle({ current }: { current: 'table' | 'kanban' }) {
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

function SlaBadge({
  target,
  status,
}: {
  target: Date | null;
  status: TicketStatus;
}) {
  if (status === 'closed' || status === 'cancelled') return null;
  if (!target) return <span className="text-muted-foreground text-xs">—</span>;
  const diffMs = new Date(target).getTime() - Date.now();
  const diffH = diffMs / 3_600_000;
  if (diffMs < 0) {
    return (
      <StatusBadge variant="danger" compact>
        просрочено на {Math.ceil(-diffH)}ч
      </StatusBadge>
    );
  }
  if (diffH < 4) {
    return (
      <StatusBadge variant="warning" compact>
        через {Math.max(1, Math.round(diffH))}ч
      </StatusBadge>
    );
  }
  if (diffH < 24) {
    return (
      <StatusBadge variant="success" compact>
        через {Math.round(diffH)}ч
      </StatusBadge>
    );
  }
  return (
    <StatusBadge variant="success" compact>
      через {Math.round(diffH / 24)}д
    </StatusBadge>
  );
}

function WaitingPartBadge() {
  return (
    <span className="bg-warning/15 text-warning inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
      <Package className="h-3 w-3" />
      ждём запчасть
    </span>
  );
}

/** Бейдж «зависшей» заявки — давно без активности. Красный мягкий фон, чтобы
 *  отличаться от амбер-бейджа «ждём запчасть» и не сливаться с ним. */
function StaleBadge({ days }: { days: number }) {
  return (
    <span
      className="bg-destructive/10 text-destructive inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
      title="Открытая заявка давно без активности"
    >
      <Clock className="h-3 w-3" />
      висит {days} дн.
    </span>
  );
}

function formatDate(d: Date) {
  return new Date(d).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
