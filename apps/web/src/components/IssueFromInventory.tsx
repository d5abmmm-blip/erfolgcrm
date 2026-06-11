/**
 * Модалка «Списать со склада в наряд» (FEFO).
 *
 * Поток (Этап 5, вариант А — две раздельных мутации):
 *   1. workOrders.upsertLine — создаём строку lineType='part' с inventoryItemId
 *      и quantity (без unitPriceRub, цена не используется на этом шаге).
 *   2. inventoryMovements.issueToWorkOrder — FEFO-ядро. На сервере: SELECT FOR UPDATE
 *      партии по item, распределяет, INSERT outbound-movements, UPDATE остатки.
 *
 * При NOT_ENOUGH_STOCK — выводим toast, строка наряда уже создана. Пользователь
 * может удалить её или добавить новую партию через приход.
 */
import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { trpc } from '../lib/trpc';

interface Props {
  ticketId: string;
  unitPriceKopecksDefault?: bigint;
  onClose: () => void;
  onIssued: () => void;
}

export function IssueFromInventory({ ticketId, onClose, onIssued }: Props) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [selectedUnit, setSelectedUnit] = useState('шт');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const list = trpc.inventoryItems.list.useQuery(
    { search: debounced || undefined, pageSize: 20 },
    { enabled: debounced.length >= 1 },
  );

  const utils = trpc.useUtils();
  const upsert = trpc.workOrders.upsertLine.useMutation();
  const issue = trpc.inventoryMovements.issueToWorkOrder.useMutation();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!selectedId) {
      setError('Выберите позицию со склада');
      return;
    }
    const qty = quantity.trim();
    if (!qty || Number(qty) <= 0) {
      setError('Количество должно быть больше 0');
      return;
    }
    try {
      const upserted = await upsert.mutateAsync({
        ticketId,
        line: {
          lineType: 'part',
          name: selectedName,
          unit: selectedUnit,
          quantity: qty,
          unitPriceRub: 0,
        },
      });
      try {
        await issue.mutateAsync({
          workOrderLineId: upserted.id,
          itemId: selectedId,
          quantity: qty,
        });
      } catch (issueErr) {
        if (issueErr instanceof Error && issueErr.message === 'NOT_ENOUGH_STOCK') {
          setError(
            'Недостаточно остатков на складе. Строка наряда сохранена без списания — добавьте партию или удалите строку.',
          );
        } else if (issueErr instanceof Error) {
          setError(issueErr.message);
        }
        return;
      }
      void utils.workOrders.getByTicket.invalidate({ ticketId });
      void utils.inventoryItems.list.invalidate();
      onIssued();
    } catch (upsertErr) {
      if (upsertErr instanceof Error) setError(upsertErr.message);
    }
  };

  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card max-h-[90vh] w-full max-w-md overflow-auto rounded-lg border shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Списать со склада</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3 p-4">
          {selectedId ? (
            <div className="bg-muted/50 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <div>
                <div className="font-medium">{selectedName}</div>
                <div className="text-muted-foreground text-xs">{selectedUnit}</div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Сбросить выбор"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  autoFocus
                  placeholder="Поиск по складу"
                  className="bg-background w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
              {debounced.length >= 1 && (
                <ul className="bg-card max-h-60 overflow-auto rounded-md border">
                  {list.isLoading && (
                    <li className="text-muted-foreground p-2 text-xs">Поиск…</li>
                  )}
                  {list.data?.items.length === 0 && (
                    <li className="text-muted-foreground p-2 text-xs">Ничего не найдено</li>
                  )}
                  {list.data?.items.map((it) => (
                    <li key={it.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(it.id);
                          setSelectedName(it.name);
                          setSelectedUnit(it.unit);
                        }}
                        className="hover:bg-muted/40 flex w-full items-center justify-between px-3 py-2 text-left text-sm transition"
                      >
                        <div>
                          <div className="font-medium">{it.name}</div>
                          {it.sku && (
                            <div className="text-muted-foreground font-mono text-xs">{it.sku}</div>
                          )}
                        </div>
                        <div className="text-muted-foreground text-xs tabular-nums">
                          ост. {it.totalRemaining} {it.unit}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <label className="block">
            <span className="text-muted-foreground text-xs font-medium">Количество</span>
            <input
              type="number"
              step="0.001"
              min="0"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="bg-background mt-1 w-full rounded-md border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
          {error && <div className="text-destructive text-sm">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="hover:bg-muted rounded-md border px-3 py-2 text-sm transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={upsert.isPending || issue.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md px-3 py-2 text-sm font-medium transition"
            >
              {upsert.isPending || issue.isPending ? 'Списание…' : 'Списать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
