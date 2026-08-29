/**
 * /tenders — реестр тендерных контрактов с реальными суммами.
 * Сводка за период (сумма контрактов / оплачено / ожидаем / кол-во) + список с фильтрами.
 * С кассой не связан: это учёт сумм и статусов (защита от задвоения доходов).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Gavel, Plus, Search } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub, formatRubWhole } from '../lib/money';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { TENDER_STATUS_META, type TenderStatus } from '../lib/dictionaries';

const PAGE_SIZE = 25;

type PresetId = 'month' | 'quarter' | 'year' | 'all';
const PRESETS: Array<{ id: PresetId; label: string }> = [
  { id: 'month', label: 'Месяц' },
  { id: 'quarter', label: 'Квартал' },
  { id: 'year', label: 'Год' },
  { id: 'all', label: 'Всё время' },
];

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function computePeriod(preset: PresetId): { from?: string; to?: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = isoLocal(now);
  switch (preset) {
    case 'month':
      return { from: isoLocal(new Date(y, m, 1)), to: today };
    case 'quarter': {
      const q = Math.floor(m / 3);
      return { from: isoLocal(new Date(y, q * 3, 1)), to: today };
    }
    case 'year':
      return { from: isoLocal(new Date(y, 0, 1)), to: today };
    case 'all':
      return {};
  }
}

interface Row {
  id: string;
  contractNumber: string;
  purchaseNumber: string | null;
  clientId: string;
  clientName: string | null;
  amountKopecks: string;
  paidKopecks: string;
  restKopecks: string;
  contractDate: string;
  dueDate: string | null;
  status: TenderStatus;
  paymentsCount: number;
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}

export function TendersListPage() {
  const [, navigate] = useLocation();
  const [preset, setPreset] = useState<PresetId>('year');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<TenderStatus | ''>('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced, status, preset]);

  const period = useMemo(() => computePeriod(preset), [preset]);

  const summary = trpc.tenders.summary.useQuery(period);
  const list = trpc.tenders.list.useQuery({
    search: debounced || undefined,
    status: status || undefined,
    from: period.from,
    to: period.to,
    page,
  });
  const items = (list.data?.items ?? []) as Row[];
  const total = list.data?.total ?? 0;
  const s = summary.data;

  const columns: Column<Row>[] = [
    {
      key: 'number',
      label: '№ контракта',
      render: (t) => (
        <div>
          <div className="font-medium">{t.contractNumber}</div>
          {t.purchaseNumber && (
            <div className="text-muted-foreground text-xs">закупка {t.purchaseNumber}</div>
          )}
        </div>
      ),
    },
    {
      key: 'date',
      label: 'Дата',
      className: 'text-muted-foreground tabular-nums whitespace-nowrap',
      render: (t) => fmtDate(t.contractDate),
    },
    { key: 'client', label: 'Заказчик', render: (t) => t.clientName ?? '—' },
    {
      key: 'amount',
      label: 'Сумма',
      className: 'text-right font-medium tabular-nums whitespace-nowrap',
      headerClassName: 'text-right',
      render: (t) => formatRub(t.amountKopecks),
    },
    {
      key: 'paid',
      label: 'Оплачено',
      className: 'text-right tabular-nums whitespace-nowrap',
      headerClassName: 'text-right',
      render: (t) =>
        BigInt(t.paidKopecks) > 0n ? (
          <span className="text-success">{formatRub(t.paidKopecks)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'rest',
      label: 'Осталось',
      className: 'text-right tabular-nums whitespace-nowrap',
      headerClassName: 'text-right',
      render: (t) => {
        if (t.status === 'cancelled') return <span className="text-muted-foreground">—</span>;
        const rest = BigInt(t.restKopecks);
        return rest > 0n ? (
          formatRub(t.restKopecks)
        ) : (
          <span className="text-muted-foreground">0 ₽</span>
        );
      },
    },
    {
      key: 'status',
      label: 'Статус',
      render: (t) => (
        <StatusBadge variant={TENDER_STATUS_META[t.status].variant}>
          {TENDER_STATUS_META[t.status].label}
        </StatusBadge>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Gavel className="h-3.5 w-3.5" />
            Тендеры
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Тендерные контракты</h1>
          <p className="text-muted-foreground text-sm">
            Реестр контрактов с реальными суммами. С кассой не связан — деньги учитываются отдельно.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="bg-secondary inline-flex rounded-md p-0.5">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                className={
                  'rounded px-2.5 py-1 text-sm font-medium transition ' +
                  (preset === p.id
                    ? 'bg-background shadow-sm'
                    : 'text-muted-foreground hover:text-foreground')
                }
              >
                {p.label}
              </button>
            ))}
          </div>
          <Link
            href="/tenders/new"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Новый тендер
          </Link>
        </div>
      </div>

      {/* Сводка за период */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile label="Сумма контрактов" value={s ? formatRubWhole(s.amountKopecks) : '…'} />
        <SummaryTile
          label="Оплачено"
          value={s ? formatRubWhole(s.paidKopecks) : '…'}
          tone="success"
        />
        <SummaryTile
          label="Ожидаем оплату"
          value={s ? formatRubWhole(s.outstandingKopecks) : '…'}
        />
        <SummaryTile label="Контрактов" value={s ? String(s.count) : '…'} hint="без расторгнутых" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по заказчику, № контракта, № закупки"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as TenderStatus | '')}
          className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
        >
          <option value="">Все статусы</option>
          {(Object.keys(TENDER_STATUS_META) as TenderStatus[]).map((st) => (
            <option key={st} value={st}>
              {TENDER_STATUS_META[st].label}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error}
        emptyText="Тендеров за этот период нет"
        rowKey={(t) => t.id}
        onRowClick={(t) => navigate(`/tenders/${t.id}`)}
      />
      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'success';
}) {
  const color = tone === 'success' ? 'text-success' : '';
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      <div className={'mt-1 text-lg font-semibold tabular-nums ' + color}>{value}</div>
      {hint && <div className="text-muted-foreground mt-0.5 text-[11px]">{hint}</div>}
    </div>
  );
}
