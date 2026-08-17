import { useState } from 'react';
import { Link } from 'wouter';
import {
  Clock,
  Flame,
  Package,
  Plus,
  Search,
  Ticket as TicketIcon,
  LayoutGrid,
  List,
  User,
} from 'lucide-react';
import type { TicketStatus, TicketPriority } from '@erfolg/shared';
import { isLegacyId, isLegacyNumber } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { useDebounce } from '../lib/hooks/useDebounce';
import { assetIdentifierLine } from '../lib/asset-identifiers';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';
import { LegacyBadge } from '../components/ui/LegacyBadge';
import { Pagination } from '../components/ui/Pagination';
import {
  TICKET_STATUS_META,
  TICKET_PRIORITY_META,
  ACTIVE_TICKET_STATUSES,
  isTicketStale,
} from '../lib/dictionaries';

/** Статусы в фильтре списка: рабочие + завершённые. Устаревшие «Смета»/«Согласование» скрыты. */
const FILTER_STATUSES: readonly TicketStatus[] = [...ACTIVE_TICKET_STATUSES, 'closed', 'cancelled'];

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
  assetInventoryNumber: string | null;
  assignedEngineerId: string | null;
  assignedEngineerName: string | null;
  deadlineAt: Date | null;
  receivedAt: Date;
  waitingForPart: boolean;
  idleDays: number;
}

const PAGE_SIZE = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Инженер из адресной строки: `/tickets?engineerId=…`.
 *
 * Сюда приходят с карточки сотрудника по ссылке «Все заявки →» — раньше она
 * вела на список ВСЕЙ КОМПАНИИ, потому что фильтра по инженеру в списке заявок
 * не было вовсе, хотя `tickets.list` принимает `engineerId` с самого начала.
 *
 * Мусор отбрасываем: сервер ждёт uuid и на «кто-то» ответит сырой ошибкой
 * валидации вместо списка. Тот же приём, что у статуса счёта в #161.
 */
export function engineerIdFromQuery(search: string): string | null {
  const raw = new URLSearchParams(search).get('engineerId');
  return raw && UUID_RE.test(raw) ? raw : null;
}

export function TicketsListPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [statuses, setStatuses] = useState<TicketStatus[]>([]);
  const [onlyWaitingPart, setOnlyWaitingPart] = useState(false);
  const [onlyUrgent, setOnlyUrgent] = useState(false);
  const [engineerId, setEngineerId] = useState<string | null>(() =>
    engineerIdFromQuery(window.location.search),
  );
  const [page, setPage] = useState(1);

  // Список нужен только чтобы назвать инженера словами: «показаны заявки
  // такого-то» вместо идентификатора в адресе. Кэшируем — он почти не меняется.
  const engineersQ = trpc.users.list.useQuery(
    { onlyEngineers: true, includeBlocked: true },
    { staleTime: 5 * 60 * 1000, enabled: engineerId !== null },
  );
  const engineerName = (engineersQ.data ?? []).find((u) => u.id === engineerId)?.fullName ?? null;

  const list = trpc.tickets.list.useQuery({
    search: debounced || undefined,
    statuses: statuses.length > 0 ? statuses : undefined,
    priorities: onlyUrgent ? ['urgent'] : undefined,
    waitingForPart: onlyWaitingPart ? true : undefined,
    engineerId: engineerId ?? undefined,
    // Рабочая очередь: срочные наверх, внутри срочности — свежие первыми.
    sort: 'priority',
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
      render: (t) => {
        const legacy = isLegacyNumber(t.ticketNumber) || isLegacyId(t.id);
        return (
          <div className="flex flex-col items-start gap-1">
            <Link
              href={`/tickets/${t.id}`}
              className="text-foreground hover:text-primary font-mono font-medium"
            >
              {t.ticketNumber}
            </Link>
            {legacy && <LegacyBadge compact />}
            {t.waitingForPart && <WaitingPartBadge />}
            {/* «Висит N дн.» на перенесённой заявке даёт четырёхзначные числа: у неё
                дата приёма из старой программы, иногда 2015 год. Такой бейдж не
                сообщает ничего и обесценивает тот же бейдж на живых заявках. */}
            {!legacy && isTicketStale(t.status, t.idleDays) && <StaleBadge days={t.idleDays} />}
          </div>
        );
      },
    },
    {
      key: 'client',
      label: 'Клиент',
      render: (t) => (
        <Link href={`/clients/${t.clientId}`} className="text-muted-foreground hover:text-primary">
          {t.clientDisplayName}
        </Link>
      ),
    },
    {
      key: 'asset',
      label: 'Техника',
      render: (t) => {
        if (!t.assetModel) return <span className="text-muted-foreground">—</span>;
        const ids = assetIdentifierLine({
          serialNumber: t.assetSerialNumber,
          inventoryNumber: t.assetInventoryNumber,
        });
        return (
          <div>
            <Link href={`/assets/${t.assetId}`} className="text-foreground hover:text-primary">
              {t.assetModel}
            </Link>
            {ids && <div className="text-muted-foreground font-mono text-xs">{ids}</div>}
          </div>
        );
      },
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
      key: 'deadline',
      label: 'Срок',
      render: (t) => <DeadlineBadge deadline={t.deadlineAt} status={t.status} />,
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
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">
            {engineerId ? 'Заявки инженера' : 'Все заявки'}
          </h1>
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

      {/* Пришли с карточки сотрудника — говорим, чьи заявки показаны, и даём
          выход ко всем. Без этой строки отфильтрованный список выглядит как
          «в компании всего 40 заявок». */}
      {engineerId && (
        <div className="bg-primary/10 border-primary/30 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <User className="text-primary h-4 w-4" />
          <span>
            Показаны заявки: <b>{engineerName ?? 'выбранный инженер'}</b>
          </span>
          <button
            type="button"
            onClick={() => {
              setEngineerId(null);
              setPage(1);
              window.history.replaceState({}, '', '/tickets');
            }}
            className="text-muted-foreground hover:text-foreground ml-auto rounded-md border px-2 py-0.5 text-xs"
          >
            Показать все заявки
          </button>
        </div>
      )}

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
            placeholder="Номер T- или WSP-, клиент, модель техники, симптом…"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {FILTER_STATUSES.map((s) => {
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
            setOnlyUrgent((v) => !v);
            setPage(1);
          }}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition',
            onlyUrgent
              ? 'border-destructive bg-destructive/10 text-destructive'
              : 'border-border text-muted-foreground hover:border-foreground/30',
          )}
        >
          <Flame className="h-3 w-3" />
          Только срочные
        </button>

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

      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}

function ViewToggle({ current }: { current: 'table' | 'kanban' }) {
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

/**
 * Срок по заявке — ТОТ, КОТОРЫЙ ПОСТАВИЛ ЧЕЛОВЕК (`deadline_at`).
 *
 * Раньше здесь показывался автоматический норматив от приоритета
 * (`sla_target_at`), и по одной заявке человек видел два разных «срока»:
 * один тут, другой в календаре и в карточке сотрудника. Решение владельца
 * 2026-08-17: на рабочих экранах остаётся ручной, норматив живёт только в
 * отчёте SLA как мера качества работы.
 */
function DeadlineBadge({ deadline, status }: { deadline: Date | null; status: TicketStatus }) {
  const target = deadline;
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
