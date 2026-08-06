/**
 * Список лидов (воронка продаж) + KPI-строка по funnelStats.
 * RBAC: staff (директор/диспетчер) — роут защищён на сервере + пункт меню с roles.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { Plus, Search, Target, TrendingUp } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { useDebounce } from '../lib/hooks/useDebounce';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import {
  LEAD_STATUS_META,
  LEAD_STATUS_ORDER,
  formatLeadMoney,
  type LeadStatus,
} from './leads.shared';

const STATUS_OPTIONS: Array<{ value: LeadStatus | ''; label: string }> = [
  { value: '', label: 'Все стадии' },
  ...LEAD_STATUS_ORDER.map((s) => ({ value: s, label: LEAD_STATUS_META[s].label })),
];

interface LeadRow {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  region: string | null;
  estimatedValue: number;
  score: number;
  status: LeadStatus;
  assignedUserName: string | null;
}

const PAGE_SIZE = 25;

export function LeadsListPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [page, setPage] = useState(1);

  const list = trpc.leads.list.useQuery({
    search: debounced || undefined,
    status: status || undefined,
    page,
  });
  const stats = trpc.leads.funnelStats.useQuery();

  const items = (list.data?.items ?? []) as LeadRow[];
  const total = list.data?.total ?? 0;

  const columns: Column<LeadRow>[] = [
    {
      key: 'name',
      label: 'Лид',
      render: (l) => (
        <div className="min-w-0">
          <Link href={`/leads/${l.id}`} className="text-foreground hover:text-primary font-medium">
            {l.name}
          </Link>
          {l.contactPerson && (
            <div className="text-muted-foreground truncate text-xs">{l.contactPerson}</div>
          )}
        </div>
      ),
    },
    {
      key: 'phone',
      label: 'Телефон',
      className: 'text-xs',
      render: (l) => l.phone ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'region',
      label: 'Регион',
      className: 'text-xs',
      render: (l) => l.region ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'estimatedValue',
      label: 'Сумма',
      className: 'text-xs tabular-nums',
      render: (l) => formatLeadMoney(l.estimatedValue),
    },
    {
      key: 'score',
      label: 'Скоринг',
      render: (l) => <ScoreBadge score={l.score} />,
    },
    {
      key: 'assignedUserName',
      label: 'Ответственный',
      className: 'text-xs',
      render: (l) => l.assignedUserName ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'status',
      label: 'Стадия',
      render: (l) => {
        const meta = LEAD_STATUS_META[l.status];
        return <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>;
      },
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Target className="h-3.5 w-3.5" />
            Лиды
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Воронка продаж</h1>
          <p className="text-muted-foreground text-sm">
            Потенциальные клиенты — от первого контакта до конвертации
          </p>
        </div>
        <Link
          href="/leads/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Новый лид
        </Link>
      </div>

      {/* KPI-строка по воронке */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Всего лидов" value={stats.data ? String(stats.data.total) : '—'} />
        <KpiCard
          label="Потенциал"
          value={stats.data ? formatLeadMoney(stats.data.totalPotential) : '—'}
        />
        <KpiCard
          label="Конверсия"
          value={stats.data ? `${stats.data.overallConversion}%` : '—'}
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <KpiCard
          label="Выручка (won)"
          value={stats.data ? formatLeadMoney(stats.data.wonRevenue) : '—'}
        />
      </div>

      {/* Полоса воронки по стадиям */}
      {stats.data && (
        <div className="flex flex-wrap gap-2">
          {LEAD_STATUS_ORDER.map((s) => {
            const meta = LEAD_STATUS_META[s];
            const bucket = stats.data.byStatus[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setStatus((prev) => (prev === s ? '' : s));
                  setPage(1);
                }}
                className={
                  'hover:bg-muted flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition ' +
                  (status === s ? 'border-primary ring-primary/30 ring-1' : '')
                }
              >
                <StatusBadge variant={meta.variant} compact>
                  {meta.label}
                </StatusBadge>
                <span className="font-semibold">{bucket.count}</span>
              </button>
            );
          })}
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
            placeholder="Поиск по названию, контакту, телефону, email"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as LeadStatus | '');
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
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Лидов не найдено"
        rowKey={(l) => l.id}
      />

      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}

function KpiCard({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const variant: StatusBadgeVariant = score >= 70 ? 'success' : score >= 40 ? 'warning' : 'muted';
  return (
    <StatusBadge variant={variant} compact>
      {score}
    </StatusBadge>
  );
}
