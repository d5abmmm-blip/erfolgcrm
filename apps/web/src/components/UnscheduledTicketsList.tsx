/**
 * Stage 11 — Sidebar со списком незапланированных заявок для drag-and-drop в график.
 *
 * Показывает только активные тикеты без `scheduledStartAt`. Каждая карточка
 * draggable: `dataTransfer.setData('text/ticket-id', id)` — это формат, который
 * читает WeekScheduleCalendar при drop.
 *
 * Поиск дебоунсится на 300 мс (как в TicketsListPage).
 */
import { useState } from 'react';
import { Search, Inbox } from 'lucide-react';
import type { TicketStatus, TicketPriority } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { useDebounce } from '../lib/hooks/useDebounce';
import { StatusBadge } from './ui/StatusBadge';
import { TICKET_STATUS_META, TICKET_PRIORITY_META } from '../lib/dictionaries';

interface UnscheduledTicket {
  id: string;
  ticketNumber: string;
  status: TicketStatus;
  priority: TicketPriority;
  clientDisplayName: string;
  assetModel: string | null;
}

interface Props {
  onTicketClick: (id: string) => void;
}

const ACTIVE_FOR_SCHEDULE: TicketStatus[] = ['received', 'diagnostics', 'in_progress'];

export function UnscheduledTicketsList({ onTicketClick }: Props) {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);

  const list = trpc.tickets.list.useQuery({
    scheduled: false,
    statuses: ACTIVE_FOR_SCHEDULE,
    search: debounced || undefined,
    // Планируем в первую очередь срочное.
    sort: 'priority',
    pageSize: 100,
  });

  const items = (list.data?.items ?? []) as UnscheduledTicket[];

  return (
    <div className="bg-card flex h-full flex-col rounded-lg border">
      <div className="border-b p-3">
        <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
          <Inbox className="h-3.5 w-3.5" />
          Незапланированные
          <span className="bg-muted text-muted-foreground ml-auto rounded px-1.5 py-0.5 text-[10px] tabular-nums">
            {items.length}
          </span>
        </div>
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="№, клиент, модель…"
            className="bg-background focus:border-primary w-full rounded-md border py-1.5 pl-7 pr-2 text-xs outline-none"
          />
        </div>
      </div>

      <div className="flex-1 space-y-1.5 overflow-auto p-2">
        {list.isLoading ? (
          <div className="text-muted-foreground p-4 text-center text-xs">Загрузка…</div>
        ) : list.error ? (
          <div className="text-destructive p-4 text-xs">Ошибка: {list.error.message}</div>
        ) : items.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-xs">
            {debounced ? 'ничего не найдено' : 'все заявки запланированы'}
          </div>
        ) : (
          items.map((t) => (
            <UnscheduledCard key={t.id} ticket={t} onClick={() => onTicketClick(t.id)} />
          ))
        )}
      </div>
    </div>
  );
}

function UnscheduledCard({
  ticket: t,
  onClick,
}: {
  ticket: UnscheduledTicket;
  onClick: () => void;
}) {
  const status = TICKET_STATUS_META[t.status];
  const priority = TICKET_PRIORITY_META[t.priority];
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/ticket-id', t.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'bg-background hover:border-primary/40 cursor-grab rounded-md border p-2 text-xs shadow-sm transition active:cursor-grabbing',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono font-medium">{t.ticketNumber}</span>
        <StatusBadge variant={priority.variant} compact>
          {priority.label}
        </StatusBadge>
      </div>
      <div className="mt-1 truncate font-medium" title={t.clientDisplayName}>
        {t.clientDisplayName}
      </div>
      <div className="text-muted-foreground mt-0.5 truncate" title={t.assetModel ?? ''}>
        {t.assetModel ?? '—'}
      </div>
      <div className="mt-1.5">
        <StatusBadge variant={status.variant} compact>
          {status.label}
        </StatusBadge>
      </div>
    </div>
  );
}
