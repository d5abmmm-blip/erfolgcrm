import { useState } from 'react';
import { X } from 'lucide-react';
import { trpc } from '../lib/trpc';

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export function InventoryItemForm({ onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [unit, setUnit] = useState('шт');
  const [minStock, setMinStock] = useState('0');
  const [category, setCategory] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = trpc.inventoryItems.create.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Наименование обязательно');
      return;
    }
    create.mutate({
      name: name.trim(),
      sku: sku.trim() || null,
      manufacturer: manufacturer.trim() || null,
      unit: unit.trim() || 'шт',
      minStock: minStock.trim() || '0',
      category: category.trim() || null,
    });
  };

  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card max-h-[90vh] w-full max-w-md overflow-auto rounded-lg border shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Новая позиция</h2>
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
          <Field label="Наименование" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Артикул">
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </Field>
            <Field label="Производитель">
              <input
                type="text"
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Ед.">
              <input
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </Field>
            <Field label="Мин. остаток">
              <input
                type="text"
                value={minStock}
                onChange={(e) => setMinStock(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2"
              />
            </Field>
            <Field label="Категория">
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </Field>
          </div>
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
              {create.isPending ? 'Сохраняем…' : 'Сохранить'}
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
