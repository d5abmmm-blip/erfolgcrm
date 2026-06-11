/**
 * Этап 6 — модалка «Вернуть запчасть на склад».
 *
 * Доступно для строк наряда lineType='part' с inventoryItemId (т.е. ранее списанных через FEFO).
 * По умолчанию возврат идёт в самую свежую партию item'а; пользователь может оставить как есть
 * (server её сам найдёт). Сторно прежнего outbound-движения не делается — добавляется новое
 * inbound-движение, история сохраняется.
 */
import { useState } from 'react';
import { Undo2, X } from 'lucide-react';
import { trpc } from '../lib/trpc';

interface PartLine {
  id: string;
  name: string;
  quantity: string;
  inventoryItemId: string | null;
  lineType: 'work' | 'part' | 'expense';
}

interface Props {
  ticketId: string;
  lines: PartLine[];
  onClose: () => void;
  onReturned: () => void;
}

export function ReturnToInventory({ ticketId, lines, onClose, onReturned }: Props) {
  const eligible = lines.filter((l) => l.lineType === 'part' && l.inventoryItemId);
  const [selectedId, setSelectedId] = useState<string>(eligible[0]?.id ?? '');
  const selected = eligible.find((l) => l.id === selectedId);
  const [quantity, setQuantity] = useState(selected?.quantity ?? '');
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const ret = trpc.inventoryMovements.returnFromWorkOrder.useMutation();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!selected || !selected.inventoryItemId) {
      setError('Выберите строку наряда');
      return;
    }
    const q = quantity.trim();
    if (!q || Number(q) <= 0) {
      setError('Количество > 0');
      return;
    }
    try {
      await ret.mutateAsync({
        workOrderLineId: selected.id,
        itemId: selected.inventoryItemId,
        quantity: q,
        comment: 'Возврат на склад',
      });
      await Promise.all([
        utils.workOrders.getByTicket.invalidate({ ticketId }),
        utils.inventoryItems.movements.invalidate({ itemId: selected.inventoryItemId }),
        utils.inventoryBatches.listByItem.invalidate({ itemId: selected.inventoryItemId }),
      ]);
      onReturned();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'RETURN_EXCEEDS_BATCH_INITIAL') {
        setError('Возврат превышает первоначальный объём партии. Оформите как новый приход.');
      } else {
        setError(msg);
      }
    }
  };

  if (eligible.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
        <div className="bg-card w-full max-w-sm rounded-lg border p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="text-sm">
            В наряде нет строк, списанных со склада.
          </div>
          <div className="mt-3 text-right">
            <button type="button" onClick={onClose} className="text-primary text-sm">Закрыть</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-card w-full max-w-md rounded-lg border p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold">
            <Undo2 className="h-4 w-4" />
            Вернуть на склад
          </h3>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mb-2 block text-xs">
          <span className="text-muted-foreground">Строка наряда</span>
          <select
            value={selectedId}
            onChange={(e) => {
              setSelectedId(e.target.value);
              const next = eligible.find((l) => l.id === e.target.value);
              if (next) setQuantity(next.quantity);
            }}
            className="bg-background mt-1 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          >
            {eligible.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} (списано {l.quantity})
              </option>
            ))}
          </select>
        </label>

        <label className="mb-3 block text-xs">
          <span className="text-muted-foreground">Количество к возврату</span>
          <input
            type="text"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="напр. 1.000"
            className="bg-background mt-1 w-full rounded-md border px-2 py-1.5 text-sm tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>

        <div className="text-muted-foreground mb-3 text-xs">
          Возврат идёт в самую свежую партию по item. Если объём не помещается —
          ошибка, оформите как новый приход.
        </div>

        {error && <div className="text-destructive mb-2 text-xs">{error}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-muted-foreground text-sm">
            Отмена
          </button>
          <button
            type="submit"
            disabled={ret.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {ret.isPending ? 'Возвращаем…' : 'Вернуть'}
          </button>
        </div>
      </form>
    </div>
  );
}
