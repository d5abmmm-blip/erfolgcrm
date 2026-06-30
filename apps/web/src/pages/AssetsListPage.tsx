import { useState } from 'react';
import { Link } from 'wouter';
import { BookMarked, Plus, Search, Wrench } from 'lucide-react';
import type { AssetLifecycleStatus } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { useDebounce } from '../lib/hooks/useDebounce';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { ASSET_STATUS_META } from '../lib/dictionaries';

const STATUS_OPTIONS: Array<{ value: AssetLifecycleStatus | ''; label: string }> = [
  { value: '', label: 'Все' },
  { value: 'in_service', label: 'В работе' },
  { value: 'in_repair', label: 'В ремонте' },
  { value: 'awaiting_parts', label: 'Ждёт запчасти' },
  { value: 'reserve', label: 'Резерв' },
  { value: 'decommissioned', label: 'Списана' },
];

type StatusOption = AssetLifecycleStatus | '';

interface AssetRow {
  id: string;
  model: string;
  manufacturer: string | null;
  deviceType: string | null;
  serialNumber: string | null;
  ownerClientId: string | null;
  ownerDisplayName: string | null;
  lifecycleStatus: AssetLifecycleStatus;
  riskClass: string | null;
}

const PAGE_SIZE = 25;

export function AssetsListPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [status, setStatus] = useState<StatusOption>('');
  const [page, setPage] = useState(1);

  const list = trpc.assets.list.useQuery({
    search: debounced || undefined,
    status: status || undefined,
    page,
  });

  const items = (list.data?.items ?? []) as AssetRow[];
  const total = list.data?.total ?? 0;

  const columns: Column<AssetRow>[] = [
    {
      key: 'model',
      label: 'Модель',
      render: (a) => (
        <div>
          <Link
            href={`/assets/${a.id}`}
            className="text-foreground hover:text-primary font-medium"
          >
            {a.model}
          </Link>
          {a.deviceType && (
            <div className="text-muted-foreground text-xs">{a.deviceType}</div>
          )}
          {a.manufacturer && (
            <div className="text-muted-foreground text-xs">{a.manufacturer}</div>
          )}
        </div>
      ),
    },
    {
      key: 'serialNumber',
      label: 'Серийный №',
      className: 'font-mono text-xs',
      render: (a) => a.serialNumber ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'owner',
      label: 'Владелец',
      render: (a) =>
        a.ownerClientId ? (
          <Link
            href={`/clients/${a.ownerClientId}`}
            className="text-muted-foreground hover:text-primary"
          >
            {a.ownerDisplayName}
          </Link>
        ) : (
          <span className="text-muted-foreground">— без клиента</span>
        ),
    },
    {
      key: 'status',
      label: 'Статус',
      render: (a) => {
        const meta = ASSET_STATUS_META[a.lifecycleStatus];
        return <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>;
      },
    },
    {
      key: 'riskClass',
      label: 'Класс риска',
      className: 'text-center font-mono',
      headerClassName: 'text-center',
      render: (a) => a.riskClass ?? '—',
    },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Wrench className="h-3.5 w-3.5" />
            Техника
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Парк техники</h1>
          <p className="text-muted-foreground text-sm">
            Все единицы оборудования с привязкой к клиентам и хронологией состояний
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/asset-models"
            className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition"
          >
            <BookMarked className="h-4 w-4" />
            Каталог моделей
          </Link>
          <Link
            href="/assets/new"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Добавить технику
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Поиск по модели, серийнику, инв. номеру"
            className="bg-background w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StatusOption);
            setPage(1);
          }}
          className="bg-background rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Техника не найдена"
        rowKey={(a) => a.id}
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
