import { useState } from 'react';
import { X } from 'lucide-react';
import { trpc } from '../lib/trpc';

interface Props {
  itemId: string;
  onClose: () => void;
  onSaved: () => void;
}

export function InventoryBatchForm({ itemId, onClose, onSaved }: Props) {
  const [batchCode, setBatchCode] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitCostRub, setUnitCostRub] = useState('0');
  const [supplier, setSupplier] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = trpc.inventoryBatches.create.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!quantity || Number(quantity) <= 0) {
      setError('Количество должно быть больше 0');
      return;
    }
    create.mutate({
      itemId,
      batchCode: batchCode.trim() || null,
      quantity: quantity.trim(),
      unitCostRub: Math.max(0, Math.round(Number(unitCostRub) || 0)),
      supplier: supplier.trim() || null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });
  };

  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card max-h-[90vh] w-full max-w-md overflow-auto rounded-lg border shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Приход партии</h2>
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Код / накладная">
              <input
                type="text"
                value={batchCode}
                onChange={(e) => setBatchCode(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </Field>
            <Field label="Поставщик">
              <input
                type="text"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Количество" required>
              <input
                type="number"
                step="0.001"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2"
              />
            </Field>
            <Field label="Себестоимость, ₽/ед.">
              <input
                type="number"
                step="1"
                min="0"
                value={unitCostRub}
                onChange={(e) => setUnitCostRub(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2"
              />
            </Field>
          </div>
          <Field label="Срок годности (если есть)">
            <input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </Field>
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
              disabled={create.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {create.isPending ? 'Сохраняем…' : 'Принять'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-muted-foreground text-xs font-medium">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
