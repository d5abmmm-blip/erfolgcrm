/**
 * /sales — реестр продаж запчастей/оборудования клиентам.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Check, Plus, Search, ShoppingCart } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub } from '../lib/money';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { SALE_STATUS_META, type SaleStatus } from '../lib/dictionaries';

const PAGE_SIZE = 25;

interface Row {
  id: string;
  saleNo: number;
  clientId: string;
  clientName: string | null;
  status: SaleStatus;
  totalKopecks: string;
  itemsCount: number;
  isPaid: boolean;
  paidOn: string | null;
}

export function SalesListPage() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<SaleStatus | ''>('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const list = trpc.sales.list.useQuery({
    search: debounced || undefined,
    status: status || undefined,
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
      label: 'Сумма',
      className: 'text-right font-medium tabular-nums',
      headerClassName: 'text-right',
      render: (s) => formatRub(s.totalKopecks),
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

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <ShoppingCart className="h-3.5 w-3.5" />
            Продажи
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">
            Продажи запчастей и оборудования
          </h1>
        </div>
        <Link
          href="/sales/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Новая продажа
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
            placeholder="Поиск по клиенту, поставщику, №"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as SaleStatus | '');
            setPage(1);
          }}
          className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
        >
          <option value="">Все статусы</option>
          {(Object.keys(SALE_STATUS_META) as SaleStatus[]).map((s) => (
            <option key={s} value={s}>
              {SALE_STATUS_META[s].label}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Продаж пока нет"
        rowKey={(s) => s.id}
        onRowClick={(s) => navigate(`/sales/${s.id}`)}
      />
      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}
