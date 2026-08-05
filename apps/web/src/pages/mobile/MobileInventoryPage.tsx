import { useState } from 'react';
import { Link } from 'wouter';
import { AlertCircle, Package, Search } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { cn } from '../../lib/utils';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { QueryError } from '../../components/QueryError';

/**
 * Мобильная страница склада: поиск + остатки.
 * Тач-таргеты ≥48px, минимум полей в строке.
 */
export function MobileInventoryPage() {
  const [search, setSearch] = useState('');
  // Debounce: раньше запрос уходил на сервер на каждую введённую букву.
  const debouncedSearch = useDebouncedValue(search.trim());

  const list = trpc.inventoryItems.list.useQuery({
    search: debouncedSearch || undefined,
    pageSize: 100,
  });

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <Package className="text-muted-foreground h-5 w-5" />
        <h1 className="text-lg font-semibold">Склад</h1>
      </div>

      <div className="relative">
        <Search className="text-muted-foreground absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по названию или артикулу"
          className="bg-background w-full rounded-lg border py-3 pl-9 pr-3 text-base outline-none focus:ring-2 focus:ring-primary/40"
          autoComplete="off"
        />
      </div>

      {list.isLoading ? (
        <div className="text-muted-foreground py-8 text-center text-sm">Загрузка…</div>
      ) : list.error ? (
        <QueryError
          error={list.error}
          paused={list.fetchStatus === 'paused'}
          what="остатки склада"
          onRetry={() => void list.refetch()}
        />
      ) : items.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm">Ничего не найдено</div>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => {
            const remaining = Number(it.totalRemaining);
            const minStock = Number(it.minStock);
            const isLow = minStock > 0 && remaining < minStock;
            return (
              <li key={it.id}>
                <Link
                  href={`/m/inventory/${it.id}`}
                  className="bg-card hover:bg-muted/30 flex items-center justify-between rounded-lg border p-3 transition active:scale-[0.99]"
                >
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="truncate font-medium">{it.name}</div>
                    {it.sku && (
                      <div className="text-muted-foreground truncate font-mono text-xs">
                        {it.sku}
                      </div>
                    )}
                  </div>
                  <div
                    className={cn(
                      'shrink-0 text-right tabular-nums',
                      isLow && 'text-destructive',
                    )}
                  >
                    <div className="flex items-center gap-1 text-lg font-bold">
                      {isLow && <AlertCircle className="h-4 w-4" />}
                      {remaining}
                    </div>
                    <div className="text-muted-foreground text-xs">{it.unit}</div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
