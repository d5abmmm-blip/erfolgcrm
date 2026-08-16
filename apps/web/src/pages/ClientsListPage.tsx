import { useState } from 'react';
import { Link } from 'wouter';
import { Plus, Search, Users } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { useDebounce } from '../lib/hooks/useDebounce';
import { listEmptyText } from '../lib/empty-text';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';

type Status = 'active' | 'archived';

interface ClientRow {
  id: string;
  displayName: string;
  type: 'legal' | 'individual';
  subtype: 'commercial' | 'budget' | null;
  inn: string | null;
  phone: string | null;
  assetsCount: number;
}

const STATUS_TABS: Array<{ key: Status; label: string }> = [
  { key: 'active', label: 'Активные' },
  { key: 'archived', label: 'Архив' },
];

const PAGE_SIZE = 25;

function clientTypeBadge(c: ClientRow): { label: string; variant: StatusBadgeVariant } {
  if (c.type === 'individual') return { label: 'Физлицо', variant: 'muted' };
  if (c.subtype === 'budget') return { label: 'Бюджет', variant: 'info' };
  return { label: 'Юрлицо', variant: 'info' };
}

export function ClientsListPage() {
  const [status, setStatus] = useState<Status>('active');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [page, setPage] = useState(1);

  const list = trpc.clients.list.useQuery({
    status,
    search: debounced || undefined,
    page,
  });

  const items = (list.data?.items ?? []) as ClientRow[];
  const total = list.data?.total ?? 0;

  const columns: Column<ClientRow>[] = [
    {
      key: 'displayName',
      label: 'Название',
      render: (c) => (
        <Link href={`/clients/${c.id}`} className="text-foreground hover:text-primary font-medium">
          {c.displayName}
        </Link>
      ),
    },
    {
      key: 'type',
      label: 'Тип',
      render: (c) => {
        const b = clientTypeBadge(c);
        return <StatusBadge variant={b.variant}>{b.label}</StatusBadge>;
      },
    },
    {
      key: 'inn',
      label: 'ИНН',
      className: 'font-mono text-xs',
      render: (c) => c.inn ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'phone',
      label: 'Телефон',
      render: (c) => c.phone ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'assetsCount',
      label: 'Техника',
      className: 'text-right tabular-nums',
      headerClassName: 'text-right',
      render: (c) =>
        c.assetsCount > 0 ? c.assetsCount : <span className="text-muted-foreground">—</span>,
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Users className="h-3.5 w-3.5" />
            Клиенты
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">База клиентов</h1>
          <p className="text-muted-foreground text-sm">
            Юр. лица, бюджетные организации и частные клиенты
          </p>
        </div>
        <Link
          href="/clients/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Добавить клиента
        </Link>
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
            placeholder="Поиск по названию или ИНН"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
        <div className="inline-flex rounded-md border p-0.5">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setStatus(t.key);
                setPage(1);
              }}
              className={cn(
                'rounded-sm px-3 py-1 text-xs font-medium transition',
                status === t.key
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText={listEmptyText(!!debounced, 'Клиентов пока нет — добавьте первого')}
        rowKey={(c) => c.id}
      />

      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}
