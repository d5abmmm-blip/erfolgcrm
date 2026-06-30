import { useEffect, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { trpc } from '../lib/trpc';

export interface AssetModelLite {
  model: string;
  manufacturer: string | null;
  deviceType: string | null;
  riskClass: '1' | '2a' | '2b' | '3' | null;
  requiredAttestationCategory: string | null;
}

interface Props {
  value: string | null;
  onChange: (id: string, model: AssetModelLite | null) => void;
  placeholder?: string;
}

/**
 * Combobox для выбора модели техники из каталога (asset_models).
 * - Поиск по модели/производителю (debounced).
 * - Если ничего не нашлось — кнопка «➕ Добавить модель «…»» создаёт её на лету
 *   (find-or-create на сервере, дубли не плодятся) и сразу выбирает.
 */
export function AssetModelPicker({
  value,
  onChange,
  placeholder = 'Поиск модели в каталоге…',
}: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  const utils = trpc.useUtils();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const search = trpc.assetModels.search.useQuery(
    { q: debounced },
    { enabled: debounced.length >= 1 },
  );
  const selected = trpc.assetModels.get.useQuery(
    { id: value ?? '' },
    { enabled: !!value },
  );

  const createModel = trpc.assetModels.create.useMutation({
    onSuccess: async (res, vars) => {
      await Promise.all([
        utils.assetModels.search.invalidate(),
        utils.assetModels.list.invalidate(),
      ]);
      onChange(res.id, {
        model: vars.model,
        manufacturer: vars.manufacturer ?? null,
        deviceType: vars.deviceType ?? null,
        riskClass: null,
        requiredAttestationCategory: null,
      });
      setOpen(false);
      setQ('');
    },
  });

  const items = search.data ?? [];
  // Точное совпадение по названию модели — чтобы не предлагать «добавить» дубликат.
  const hasExact = items.some(
    (m) => m.model.trim().toLowerCase() === debounced.toLowerCase(),
  );

  function pick(id: string, m: AssetModelLite) {
    onChange(id, m);
    setOpen(false);
    setQ('');
  }

  return (
    <div className="relative">
      {value && selected.data ? (
        <div className="bg-muted/50 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <div>
            <div className="font-medium">{selected.data.model}</div>
            {selected.data.manufacturer && (
              <div className="text-muted-foreground text-xs">
                {selected.data.manufacturer}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              onChange('', null);
              setQ('');
              setOpen(true);
            }}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Сбросить выбор модели"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={placeholder}
            className="bg-background w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      )}

      {open && !value && (
        <ul className="bg-card absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border shadow-lg">
          {debounced.length < 1 ? (
            <li className="text-muted-foreground p-2 text-xs">
              Введите название модели или производителя
            </li>
          ) : (
            <>
              {search.isLoading && (
                <li className="text-muted-foreground p-2 text-xs">Поиск…</li>
              )}
              {items.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="hover:bg-muted/40 w-full px-3 py-2 text-left text-sm transition"
                    onClick={() =>
                      pick(m.id, {
                        model: m.model,
                        manufacturer: m.manufacturer,
                        deviceType: m.deviceType,
                        riskClass: m.riskClass,
                        requiredAttestationCategory: m.requiredAttestationCategory,
                      })
                    }
                  >
                    <div className="font-medium">{m.model}</div>
                    {m.manufacturer && (
                      <div className="text-muted-foreground text-xs">{m.manufacturer}</div>
                    )}
                  </button>
                </li>
              ))}
              {!search.isLoading && !hasExact && (
                <li>
                  <button
                    type="button"
                    disabled={createModel.isPending}
                    className="text-primary hover:bg-primary/5 flex w-full items-center gap-1.5 border-t px-3 py-2 text-left text-sm font-medium disabled:opacity-50"
                    onClick={() => createModel.mutate({ model: debounced })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {createModel.isPending
                      ? 'Добавление…'
                      : `Добавить модель «${debounced}»`}
                  </button>
                </li>
              )}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
