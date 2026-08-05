import { Link, useRoute } from 'wouter';
import { AlertCircle, ChevronLeft, Loader2 } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { cn } from '../../lib/utils';
import { QueryError } from '../../components/QueryError';
import { fmtShortDateTime } from '../../lib/dates';

const MOVEMENT_KIND_LABEL: Record<string, string> = {
  inbound: 'Приход',
  outbound: 'Выдача',
  adjustment: 'Корректировка',
  writeoff: 'Списание',
};

/**
 * /m/inventory/:id — мобильная карточка позиции склада.
 *
 * Раньше строка склада вела в десктопный /inventory/:id: на телефоне инженера
 * открывался полный интерфейс с сайдбаром и таблицами, обратно — только руками.
 * Здесь то, что нужно в поле: остаток, минимум, последние движения.
 */
export function MobileInventoryItemPage() {
  const [, params] = useRoute<{ id: string }>('/m/inventory/:id');
  const id = params?.id ?? '';

  const item = trpc.inventoryItems.get.useQuery({ id }, { enabled: !!id });
  const movements = trpc.inventoryItems.movements.useQuery(
    { itemId: id, limit: 20 },
    { enabled: !!id },
  );

  if (item.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 p-8 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка…
      </div>
    );
  }
  if (item.error || !item.data) {
    return (
      <div className="m-3 space-y-2">
        <QueryError
          error={item.error}
          paused={item.fetchStatus === 'paused'}
          what="позицию склада"
          onRetry={() => void item.refetch()}
        />
        {!item.error && item.fetchStatus !== 'paused' && (
          <div className="text-muted-foreground text-sm">Позиция не найдена</div>
        )}
      </div>
    );
  }

  const it = item.data;
  const remaining = Number(it.totalRemaining);
  const minStock = Number(it.minStock);
  const isLow = minStock > 0 && remaining < minStock;
  const secondary = [it.manufacturer, it.category].filter(Boolean).join(' · ');

  return (
    <div className="space-y-3 p-3">
      <Link
        href="/m/inventory"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К складу
      </Link>

      <div className="bg-card space-y-3 rounded-lg border p-4">
        <div>
          <div className="text-base font-semibold">{it.name}</div>
          {it.sku && <div className="text-muted-foreground font-mono text-xs">{it.sku}</div>}
          {secondary && <div className="text-muted-foreground mt-0.5 text-xs">{secondary}</div>}
        </div>

        <div className="flex items-end justify-between border-t pt-3">
          <div>
            <div className="text-muted-foreground text-[11px] font-medium uppercase">Остаток</div>
            <div
              className={cn(
                'flex items-center gap-1.5 text-3xl font-bold tabular-nums',
                isLow && 'text-destructive',
              )}
            >
              {isLow && <AlertCircle className="h-5 w-5" />}
              {remaining}
              <span className="text-muted-foreground text-base font-medium">{it.unit}</span>
            </div>
          </div>
          {minStock > 0 && (
            <div className="text-right">
              <div className="text-muted-foreground text-[11px] font-medium uppercase">Минимум</div>
              <div className="text-muted-foreground text-lg font-semibold tabular-nums">
                {minStock}
              </div>
            </div>
          )}
        </div>

        {it.notes && (
          <div className="bg-muted/40 rounded-md p-3 text-sm whitespace-pre-wrap">{it.notes}</div>
        )}
      </div>

      <div className="bg-card rounded-lg border">
        <div className="text-muted-foreground border-b px-3 py-2 text-[11px] font-medium uppercase">
          Последние движения
        </div>
        {movements.error ? (
          <div className="p-3">
            <QueryError
              error={movements.error}
              paused={movements.fetchStatus === 'paused'}
              what="движения по позиции"
              onRetry={() => void movements.refetch()}
            />
          </div>
        ) : (movements.data?.length ?? 0) === 0 ? (
          <div className="text-muted-foreground p-3 text-sm">Движений ещё не было</div>
        ) : (
          <ul className="divide-y">
            {(movements.data ?? []).map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {MOVEMENT_KIND_LABEL[m.kind] ?? m.kind}
                  </div>
                  {m.comment && (
                    <div className="text-muted-foreground truncate text-xs">{m.comment}</div>
                  )}
                  <div className="text-muted-foreground text-[11px]">
                    {fmtShortDateTime(m.createdAt)}
                  </div>
                </div>
                <div
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    m.kind === 'inbound' ? 'text-success' : 'text-foreground',
                  )}
                >
                  {m.kind === 'inbound' ? '+' : '−'}
                  {Number(m.quantity)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
