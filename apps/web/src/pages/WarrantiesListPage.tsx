/**
 * Реестр гарантий на технику + KPI-сводка по статусам.
 * Статус вычисляется на сервере (active/expiring(≤30 дн.)/expired/voided) — не протухает.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { useDebounce } from '../lib/hooks/useDebounce';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

type WarrantyType = 'manufacturer' | 'service' | 'extended';
type WarrantyStatus = 'active' | 'expiring' | 'expired' | 'voided';

const TYPE_LABEL: Record<WarrantyType, string> = {
  manufacturer: 'Заводская',
  service: 'Сервисная',
  extended: 'Расширенная',
};

const STATUS_META: Record<WarrantyStatus, { label: string; variant: StatusBadgeVariant }> = {
  active: { label: 'Действует', variant: 'success' },
  expiring: { label: 'Истекает', variant: 'warning' },
  expired: { label: 'Истекла', variant: 'danger' },
  voided: { label: 'Аннулирована', variant: 'muted' },
};

const STATUS_OPTIONS: Array<{ value: WarrantyStatus | ''; label: string }> = [
  { value: '', label: 'Все статусы' },
  { value: 'active', label: 'Действующие' },
  { value: 'expiring', label: 'Истекающие (≤30 дн.)' },
  { value: 'expired', label: 'Истёкшие' },
  { value: 'voided', label: 'Аннулированные' },
];

const TYPE_OPTIONS: Array<{ value: WarrantyType | ''; label: string }> = [
  { value: '', label: 'Все типы' },
  { value: 'manufacturer', label: 'Заводская' },
  { value: 'service', label: 'Сервисная' },
  { value: 'extended', label: 'Расширенная' },
];

interface WarrantyRow {
  id: string;
  assetId: string;
  assetModel: string;
  assetSerialNumber: string | null;
  clientId: string | null;
  clientDisplayName: string | null;
  type: WarrantyType;
  status: WarrantyStatus;
  startDate: string;
  endDate: string;
  provider: string | null;
  contractNumber: string | null;
}

const PAGE_SIZE = 25;

export function WarrantiesListPage() {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [status, setStatus] = useState<WarrantyStatus | ''>('');
  const [type, setType] = useState<WarrantyType | ''>('');
  const [page, setPage] = useState(1);
  const [archiveId, setArchiveId] = useState<string | null>(null);

  const list = trpc.warranties.list.useQuery({
    search: debounced || undefined,
    status: (status || undefined),
    type: (type || undefined),
    page,
  });
  const stats = trpc.warranties.stats.useQuery();

  const archive = trpc.warranties.archive.useMutation({
    onSuccess: async () => {
      setArchiveId(null);
      await Promise.all([utils.warranties.list.invalidate(), utils.warranties.stats.invalidate()]);
    },
  });

  const items = (list.data?.items ?? []) as WarrantyRow[];
  const total = list.data?.total ?? 0;

  const columns: Column<WarrantyRow>[] = [
    {
      key: 'asset',
      label: 'Техника',
      render: (w) => (
        <div className="min-w-0">
          <Link
            href={`/assets/${w.assetId}`}
            className="text-foreground hover:text-primary font-medium"
          >
            {w.assetModel}
          </Link>
          {w.assetSerialNumber && (
            <div className="text-muted-foreground font-mono text-xs">s/n {w.assetSerialNumber}</div>
          )}
        </div>
      ),
    },
    {
      key: 'client',
      label: 'Клиент',
      className: 'text-xs',
      render: (w) =>
        w.clientId ? (
          <Link href={`/clients/${w.clientId}`} className="text-muted-foreground hover:text-primary">
            {w.clientDisplayName}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'type',
      label: 'Тип',
      className: 'text-xs',
      render: (w) => TYPE_LABEL[w.type],
    },
    {
      key: 'period',
      label: 'Период',
      className: 'text-xs tabular-nums',
      render: (w) => `${formatDate(w.startDate)} — ${formatDate(w.endDate)}`,
    },
    {
      key: 'provider',
      label: 'Поставщик / договор',
      className: 'text-xs',
      render: (w) => (
        <div>
          {w.provider ?? <span className="text-muted-foreground">—</span>}
          {w.contractNumber && (
            <div className="text-muted-foreground font-mono text-[11px]">{w.contractNumber}</div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Статус',
      render: (w) => {
        const meta = STATUS_META[w.status];
        return <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>;
      },
    },
    {
      key: 'actions',
      label: '',
      className: 'w-20',
      render: (w) => (
        <div className="flex items-center justify-end gap-1">
          <Link
            href={`/warranties/${w.id}/edit`}
            className="text-muted-foreground hover:text-foreground hover:bg-muted rounded px-2 py-1 text-xs"
          >
            Изменить
          </Link>
          <button
            type="button"
            onClick={() => setArchiveId(w.id)}
            aria-label="Архивировать гарантию"
            title="Архивировать"
            className="text-muted-foreground hover:text-destructive hover:bg-muted grid h-7 w-7 place-items-center rounded"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <ShieldCheck className="h-3.5 w-3.5" />
            Гарантии
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Реестр гарантий</h1>
          <p className="text-muted-foreground text-sm">
            Заводские, сервисные и расширенные гарантии по парку техники
          </p>
        </div>
        <Link
          href="/warranties/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Новая гарантия
        </Link>
      </div>

      {/* KPI по статусам */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Действуют"
          value={stats.data?.active}
          active={status === 'active'}
          onClick={() => toggleStatus('active')}
        />
        <StatCard
          label="Истекают (≤30 дн.)"
          value={stats.data?.expiring}
          tone="warning"
          active={status === 'expiring'}
          onClick={() => toggleStatus('expiring')}
        />
        <StatCard
          label="Истекли"
          value={stats.data?.expired}
          tone="danger"
          active={status === 'expired'}
          onClick={() => toggleStatus('expired')}
        />
        <StatCard
          label="Всего в реестре"
          value={stats.data?.total}
          active={false}
          onClick={() => {
            setStatus('');
            setPage(1);
          }}
        />
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
            placeholder="Поиск по модели, s/n, клиенту, поставщику, № договора"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as WarrantyStatus | '');
            setPage(1);
          }}
          className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as WarrantyType | '');
            setPage(1);
          }}
          className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
        >
          {TYPE_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Гарантий не найдено"
        rowKey={(w) => w.id}
      />

      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <ConfirmDialog
        open={!!archiveId}
        title="Архивировать гарантию?"
        description="Гарантия будет скрыта из реестра. Данные сохранятся (мягкое удаление)."
        confirmText="Архивировать"
        variant="danger"
        loading={archive.isPending}
        onConfirm={() => archiveId && archive.mutate({ id: archiveId })}
        onCancel={() => setArchiveId(null)}
      />
    </div>
  );

  function toggleStatus(s: WarrantyStatus) {
    setStatus((prev) => (prev === s ? '' : s));
    setPage(1);
  }
}

function StatCard({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number | undefined;
  tone?: 'warning' | 'danger';
  active: boolean;
  onClick: () => void;
}) {
  const toneCls =
    tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-destructive' : '';
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'bg-card hover:bg-muted/40 rounded-lg border p-3 text-left transition ' +
        (active ? 'border-primary ring-primary/30 ring-1' : '')
      }
    >
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${toneCls}`}>{value ?? '—'}</div>
    </button>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}
