/**
 * Вкладка «Список» раздела продаж — реестр продаж запчастей/оборудования.
 * Колонки: №, дата, клиент, позиций, выручка, затраты, прибыль, статус, оплата.
 * Фильтры: поиск, статус, оплата, сортировка. Период задаёт оболочка SalesPage.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Check, Search } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub } from '../lib/money';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { SALE_STATUS_META, type SaleStatus } from '../lib/dictionaries';

const PAGE_SIZE = 25;
type SortId = 'date' | 'amount' | 'profit';

interface Row {
  id: string;
  saleNo: number;
  clientId: string;
  clientName: string | null;
  status: SaleStatus;
  totalKopecks: string;
  costKopecks: string;
  marginKopecks: string | null;
  itemsCount: number;
  isPaid: boolean;
  paidOn: string | null;
  createdAt: string | Date;
}

function fmtDate(d: string | Date): string {
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleDateString('ru-RU');
}

export function SalesList({ period }: { period: { from?: string; to?: string } }) {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<SaleStatus | ''>('');
  const [paid, setPaid] = useState<'' | 'yes' | 'no'>('');
  const [sort, setSort] = useState<SortId>('date');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Любая смена фильтра/периода — на первую страницу.
  useEffect(() => {
    setPage(1);
  }, [debounced, status, paid, sort, period.from, period.to]);

  const list = trpc.sales.list.useQuery({
    search: debounced || undefined,
    status: status || undefined,
    paid: paid === '' ? undefined : paid === 'yes',
    sort,
    from: period.from,
    to: period.to,
    page,
  });
  const items = (list.data?.items ?? []) as Row[];
  const total = list.data?.total ?? 0;

  const columns: Column<Row>[] = [
    {
      key: 'saleNo',
      label: '№',
      className: 'text-muted-foreground tabular-nums',
      render: (s) => `№${s.saleNo}`,
    },
    {
      key: 'date',
      label: 'Дата',
      className: 'text-muted-foreground tabular-nums whitespace-nowrap',
      render: (s) => fmtDate(s.createdAt),
    },
    { key: 'client', label: 'Клиент', render: (s) => s.clientName ?? '—' },
    {
      key: 'itemsCount',
      label: 'Позиций',
      className: 'text-center tabular-nums',
      headerClassName: 'text-center',
      render: (s) => s.itemsCount,
    },
    {
      key: 'total',
      label: 'Выручка',
      className: 'text-right font-medium tabular-nums whitespace-nowrap',
      headerClassName: 'text-right',
      render: (s) => formatRub(s.totalKopecks),
    },
    {
      key: 'cost',
      label: 'Затраты',
      className: 'text-muted-foreground text-right tabular-nums whitespace-nowrap',
      headerClassName: 'text-right',
      render: (s) => (BigInt(s.costKopecks) > 0n ? formatRub(s.costKopecks) : '—'),
    },
    {
      key: 'margin',
      label: 'Прибыль',
      className: 'text-right font-medium tabular-nums whitespace-nowrap',
      headerClassName: 'text-right',
      render: (s) =>
        s.marginKopecks === null ? (
          <span className="text-muted-foreground" title="Закупка не указана">
            —
          </span>
        ) : (
          <span className={BigInt(s.marginKopecks) >= 0n ? 'text-success' : 'text-destructive'}>
            {formatRub(s.marginKopecks)}
          </span>
        ),
    },
    {
      key: 'status',
      label: 'Статус',
      render: (s) => (
        <StatusBadge variant={SALE_STATUS_META[s.status].variant}>
          {SALE_STATUS_META[s.status].label}
        </StatusBadge>
      ),
    },
    {
      key: 'paid',
      label: 'Оплата',
      render: (s) =>
        s.isPaid ? (
          <span className="text-success inline-flex items-center gap-1 text-xs font-medium">
            <Check className="h-3.5 w-3.5" />
            Оплачено
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">Не оплачено</span>
        ),
    },
  ];

  const selectCls =
    'bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по клиенту, поставщику, №"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as SaleStatus | '')}
          className={selectCls}
          title="Статус заказа"
        >
          <option value="">Все статусы</option>
          {(Object.keys(SALE_STATUS_META) as SaleStatus[]).map((s) => (
            <option key={s} value={s}>
              {SALE_STATUS_META[s].label}
            </option>
          ))}
        </select>
        <select
          value={paid}
          onChange={(e) => setPaid(e.target.value as '' | 'yes' | 'no')}
          className={selectCls}
          title="Оплата"
        >
          <option value="">Все оплаты</option>
          <option value="yes">Оплаченные</option>
          <option value="no">Неоплаченные</option>
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortId)}
          className={selectCls}
          title="Сортировка"
        >
          <option value="date">Сначала новые</option>
          <option value="amount">По выручке</option>
          <option value="profit">По прибыли</option>
        </select>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error}
        emptyText="Продаж за этот период нет"
        rowKey={(s) => s.id}
        onRowClick={(s) => navigate(`/sales/${s.id}`)}
      />
      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}
