import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

interface Props {
  value: string | null;
  onChange: (id: string, displayName: string) => void;
  placeholder?: string;
}

/**
 * Combobox для выбора клиента. Дёргает trpc.clients.search с debounce'ом.
 * Используется в форме создания/редактирования техники.
 */
export function ClientPicker({ value, onChange, placeholder = 'Поиск клиента...' }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const search = trpc.clients.search.useQuery(
    { q: debounced },
    { enabled: debounced.length >= 1 },
  );
  const selected = trpc.clients.get.useQuery({ id: value ?? '' }, { enabled: !!value });

  return (
    <div className="relative">
      {value && selected.data ? (
        <div className="bg-muted/50 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <div>
            <div className="font-medium">{selected.data.displayName}</div>
            {selected.data.inn && (
              <div className="text-muted-foreground font-mono text-xs">
                ИНН {selected.data.inn}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              onChange('', '');
              setQ('');
              setOpen(true);
            }}
            className="text-muted-foreground hover:text-destructive"
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
      {open && !value && debounced.length >= 1 && (
        <ul className="bg-card absolute z-10 mt-1 w-full overflow-hidden rounded-md border shadow-lg">
          {search.isLoading ? (
            <li className="text-muted-foreground p-2 text-xs">Поиск…</li>
          ) : !search.data || search.data.length === 0 ? (
            <li className="text-muted-foreground p-2 text-xs">Ничего не найдено</li>
          ) : (
            search.data.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={cn(
                    'hover:bg-muted/40 w-full px-3 py-2 text-left text-sm transition',
                  )}
                  onClick={() => {
                    onChange(c.id, c.displayName);
                    setOpen(false);
                    setQ('');
                  }}
                >
                  <div className="font-medium">{c.displayName}</div>
                  {c.inn && (
                    <div className="text-muted-foreground font-mono text-xs">ИНН {c.inn}</div>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
