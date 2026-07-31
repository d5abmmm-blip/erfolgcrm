import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { assetIdentifierLine } from '../lib/asset-identifiers';

interface Props {
  value: string | null;
  onChange: (id: string, model: string) => void;
  /** Если задан — отдаём `assets.byClient` без поиска. */
  ownerClientId?: string | null;
  placeholder?: string;
}

/**
 * Combobox для выбора единицы техники.
 *
 * - Если ownerClientId задан — список ограничен техникой клиента (без поиска).
 *   Когда у клиента нет техники в системе — показываем подсказку.
 * - Иначе — debounced search по всему парку.
 */
export function AssetPicker({
  value,
  onChange,
  ownerClientId = null,
  placeholder = 'Поиск техники по модели, s/n или инв. №…',
}: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const byClient = trpc.assets.byClient.useQuery(
    { clientId: ownerClientId ?? '' },
    { enabled: !!ownerClientId },
  );
  const search = trpc.assets.search.useQuery(
    { q: debounced },
    { enabled: !ownerClientId && debounced.length >= 1 },
  );
  const selected = trpc.assets.get.useQuery(
    { id: value ?? '' },
    { enabled: !!value },
  );

  // Сброс поискового стейта при смене владельца
  useEffect(() => {
    setQ('');
    setDebounced('');
  }, [ownerClientId]);

  const renderResults = () => {
    if (ownerClientId) {
      if (byClient.isLoading) {
        return <li className="text-muted-foreground p-2 text-xs">Загрузка…</li>;
      }
      const items = byClient.data ?? [];
      if (items.length === 0) {
        return (
          <li className="text-muted-foreground p-2 text-xs">
            У клиента нет техники в системе
          </li>
        );
      }
      return items.map((a) => (
        <li key={a.id}>
          <ItemBtn
            primary={a.model}
            secondary={assetIdentifierLine(a)}
            onClick={() => {
              onChange(a.id, a.model);
              setOpen(false);
              setQ('');
            }}
          />
        </li>
      ));
    }
    if (debounced.length < 1) {
      return (
        <li className="text-muted-foreground p-2 text-xs">
          Введите хотя бы один символ
        </li>
      );
    }
    if (search.isLoading) {
      return <li className="text-muted-foreground p-2 text-xs">Поиск…</li>;
    }
    const items = search.data ?? [];
    if (items.length === 0) {
      return <li className="text-muted-foreground p-2 text-xs">Ничего не найдено</li>;
    }
    return items.map((a) => (
      <li key={a.id}>
        <ItemBtn
          primary={a.model}
          secondary={assetIdentifierLine(a)}
          onClick={() => {
            onChange(a.id, a.model);
            setOpen(false);
            setQ('');
          }}
        />
      </li>
    ));
  };

  return (
    <div className="relative">
      {value && selected.data ? (
        <div className="bg-muted/50 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <div>
            <div className="font-medium">{selected.data.model}</div>
            {assetIdentifierLine(selected.data) && (
              <div className="text-muted-foreground font-mono text-xs">
                {assetIdentifierLine(selected.data)}
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
            aria-label="Сбросить выбор"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : ownerClientId ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="bg-background hover:bg-muted/30 w-full rounded-md border px-3 py-2 text-left text-sm outline-none focus:ring-2 focus:ring-primary/40"
        >
          <span className="text-muted-foreground">
            {byClient.isLoading
              ? 'Загрузка…'
              : (byClient.data ?? []).length === 0
                ? 'У клиента нет техники в системе'
                : 'Выберите технику клиента'}
          </span>
        </button>
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
          {renderResults()}
        </ul>
      )}
    </div>
  );
}

function ItemBtn({
  primary,
  secondary,
  onClick,
}: {
  primary: string;
  secondary?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="hover:bg-muted/40 w-full px-3 py-2 text-left text-sm transition"
      onClick={onClick}
    >
      <div className="font-medium">{primary}</div>
      {secondary && <div className="text-muted-foreground font-mono text-xs">{secondary}</div>}
    </button>
  );
}
