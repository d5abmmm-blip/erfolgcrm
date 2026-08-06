import { useState } from 'react';
import { Link } from 'wouter';
import { AlertCircle, Package, Plus, Search } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { useDebounce } from '../lib/hooks/useDebounce';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Pagination } from '../components/ui/Pagination';
import { InventoryItemForm } from '../components/InventoryItemForm';

interface InventoryRow {
  id: string;
  name: string;
  manufacturer: string | null;
  sku: string | null;
  category: string | null;
  unit: string;
  totalRemaining: string | number;
  minStock: string | number;
}

const PAGE_SIZE = 25;

export function InventoryListPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [showForm, setShowForm] = useState(false);
  const [page, setPage] = useState(1);

  const list = trpc.inventoryItems.list.useQuery({
    search: debounced || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const items = (list.data?.items ?? []) as InventoryRow[];
  const total = list.data?.total ?? 0;

  const columns: Column<InventoryRow>[] = [
    {
      key: 'name',
      label: 'Наименование',
      render: (it) => (
        <div>
          <Link
            href={`/inventory/${it.id}`}
            className="text-foreground hover:text-primary font-medium"
          >
            {it.name}
          </Link>
          {it.manufacturer && (
            <div className="text-muted-foreground text-xs">{it.manufacturer}</div>
          )}
        </div>
      ),
    },
    {
      key: 'sku',
      label: 'Артикул',
      className: 'font-mono text-xs',
      render: (it) => it.sku ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'category',
      label: 'Категория',
      render: (it) => it.category ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'remaining',
      label: 'Остаток',
      headerClassName: 'text-right',
      render: (it) => {
        const remaining = Number(it.totalRemaining);
        const minStock = Number(it.minStock);
        const isLow = minStock > 0 && remaining < minStock;
        return (
          <div className={cn('text-right tabular-nums', isLow && 'text-destructive font-semibold')}>
            <span className="inline-flex items-center gap-1">
              {isLow && <AlertCircle className="h-3.5 w-3.5" />}
              {remaining} {it.unit}
            </span>
          </div>
        );
      },
    },
    {
      key: 'minStock',
      label: 'Мин.',
      className: 'text-muted-foreground text-right tabular-nums text-xs',
      headerClassName: 'text-right',
      render: (it) => {
        const minStock = Number(it.minStock);
        return minStock > 0 ? minStock : '—';
      },
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Package className="h-3.5 w-3.5" />
            Склад
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Запчасти и расходники</h1>
          <p className="text-muted-foreground text-sm">Справочник позиций с FEFO-учётом партий</p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Добавить позицию
        </button>
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
            placeholder="Поиск по названию или артикулу"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Позиций пока нет — добавьте первую"
        rowKey={(it) => it.id}
      />

      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      {showForm && (
        <InventoryItemForm
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            void list.refetch();
          }}
        />
      )}
    </div>
  );
}
