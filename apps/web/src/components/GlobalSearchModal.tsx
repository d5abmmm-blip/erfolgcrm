/**
 * Глобальный поиск (Cmd+K / Ctrl+K).
 *
 * Внутри: input + 5 секций (Заявки/Клиенты/Техника/Счета/Договоры). Дебаунс 200мс,
 * клавиши ↑↓ навигация, Enter — переход, Esc — закрытие. По клику закрывается
 * и переходит на нужную страницу (/tickets/:id, /clients/:id и т.д.).
 *
 * UI-токены: bg-popover, border-border, text-muted-foreground, text-primary.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { Search, X, Loader2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { kopecksToRub } from '../lib/money';

interface GlobalSearchModalProps {
  open: boolean;
  onClose: () => void;
}

interface FlatHit {
  key: string;
  href: string;
  title: string;
  subtitle: string | null;
  group: string;
}

const STATUS_LABELS_RU: Record<string, string> = {
  received: 'Принята',
  diagnostics: 'Диагностика',
  estimate: 'Смета',
  approval: 'Согласование',
  in_progress: 'В работе',
  act_pending: 'К выдаче',
  closed: 'Закрыта',
  cancelled: 'Отменена',
  draft: 'Черновик',
  issued: 'Выставлен',
  partially_paid: 'Частично оплачен',
  paid: 'Оплачен',
  overdue: 'Просрочен',
  active: 'Активен',
  expired: 'Истёк',
  terminated: 'Расторгнут',
};

function statusRu(s: string): string {
  return STATUS_LABELS_RU[s] ?? s;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function GlobalSearchModal({ open, onClose }: GlobalSearchModalProps) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const debounced = useDebounced(query.trim(), 200);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Сбросим при каждом открытии: ввод и фокус.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  const search = trpc.search.global.useQuery(
    { query: debounced },
    { enabled: open && debounced.length >= 2, staleTime: 5_000 },
  );

  const flat = useMemo<FlatHit[]>(() => {
    const data = search.data;
    if (!data) return [];
    const acc: FlatHit[] = [];
    for (const t of data.tickets) {
      acc.push({
        key: `t:${t.id}`,
        href: `/tickets/${t.id}`,
        title: `${t.ticketNumber} · ${statusRu(t.status)}`,
        subtitle: t.clientName || null,
        group: 'Заявки',
      });
    }
    for (const c of data.clients) {
      acc.push({
        key: `c:${c.id}`,
        href: `/clients/${c.id}`,
        title: c.displayName,
        subtitle: [c.type === 'legal' ? 'Юрлицо' : 'Физлицо', c.inn].filter(Boolean).join(' · '),
        group: 'Клиенты',
      });
    }
    for (const a of data.assets) {
      acc.push({
        key: `a:${a.id}`,
        href: `/assets/${a.id}`,
        title: a.model,
        subtitle: [a.serialNumber ? `S/N ${a.serialNumber}` : null, a.ownerClientName]
          .filter(Boolean)
          .join(' · ') || null,
        group: 'Техника',
      });
    }
    for (const i of data.invoices) {
      acc.push({
        key: `i:${i.id}`,
        href: `/invoices/${i.id}`,
        title: `${i.invoiceNumber} · ${statusRu(i.status)}`,
        subtitle: `${kopecksToRub(i.totalAmountKopecks)} ₽`,
        group: 'Счета',
      });
    }
    for (const co of data.contracts) {
      acc.push({
        key: `co:${co.id}`,
        href: `/contracts/${co.id}`,
        title: `${co.contractNumber} · ${statusRu(co.status)}`,
        subtitle: co.clientName,
        group: 'Договоры',
      });
    }
    return acc;
  }, [search.data]);

  // Сбросить активный индекс если результаты обновились.
  useEffect(() => {
    setActiveIdx(0);
  }, [flat.length]);

  // Esc / стрелки / Enter — обработка глобально на window когда модаль открыта.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((idx) => Math.min(idx + 1, Math.max(0, flat.length - 1)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((idx) => Math.max(0, idx - 1));
        return;
      }
      if (e.key === 'Enter' && flat[activeIdx]) {
        e.preventDefault();
        const target = flat[activeIdx];
        navigate(target.href);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flat, activeIdx, navigate, onClose]);

  if (!open) return null;

  const grouped = groupHits(flat);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Глобальный поиск"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="bg-popover text-popover-foreground border-border w-full max-w-xl overflow-hidden rounded-lg border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-border flex items-center gap-2 border-b px-3 py-2">
          <Search className="text-muted-foreground h-4 w-4" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск: номер заявки, клиент, серийник, счёт, договор…"
            className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none"
            aria-label="Поисковый запрос"
          />
          {search.isFetching ? (
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            aria-label="Закрыть"
            title="Esc"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          <SearchResultsBody
            query={debounced}
            isLoading={search.isLoading}
            flat={flat}
            grouped={grouped}
            activeIdx={activeIdx}
            onSelect={(href) => {
              navigate(href);
              onClose();
            }}
            onHover={setActiveIdx}
          />
        </div>

        <div className="border-border text-muted-foreground flex items-center justify-between border-t px-3 py-1.5 text-[11px]">
          <span>↑↓ навигация · Enter — открыть · Esc — закрыть</span>
          <span>Ctrl/Cmd+K</span>
        </div>
      </div>
    </div>
  );
}

function groupHits(flat: FlatHit[]): Array<{ group: string; items: Array<FlatHit & { idx: number }> }> {
  const out: Array<{ group: string; items: Array<FlatHit & { idx: number }> }> = [];
  flat.forEach((hit, idx) => {
    const last = out[out.length - 1];
    if (last && last.group === hit.group) {
      last.items.push({ ...hit, idx });
    } else {
      out.push({ group: hit.group, items: [{ ...hit, idx }] });
    }
  });
  return out;
}

interface SearchResultsBodyProps {
  query: string;
  isLoading: boolean;
  flat: FlatHit[];
  grouped: Array<{ group: string; items: Array<FlatHit & { idx: number }> }>;
  activeIdx: number;
  onSelect: (href: string) => void;
  onHover: (idx: number) => void;
}

function SearchResultsBody({
  query,
  isLoading,
  flat,
  grouped,
  activeIdx,
  onSelect,
  onHover,
}: SearchResultsBodyProps) {
  if (query.length < 2) {
    return (
      <p className="text-muted-foreground p-6 text-center text-sm">
        Введите минимум 2 символа для поиска.
      </p>
    );
  }
  if (isLoading) {
    return (
      <p className="text-muted-foreground p-6 text-center text-sm">Ищем…</p>
    );
  }
  if (flat.length === 0) {
    return (
      <p className="text-muted-foreground p-6 text-center text-sm">Ничего не найдено.</p>
    );
  }
  return (
    <div className="py-1">
      {grouped.map((g) => (
        <div key={g.group}>
          <div className="text-muted-foreground bg-muted/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide">
            {g.group}
          </div>
          {g.items.map((hit) => (
            <button
              type="button"
              key={hit.key}
              onClick={() => onSelect(hit.href)}
              onMouseEnter={() => onHover(hit.idx)}
              className={cn(
                'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition',
                hit.idx === activeIdx
                  ? 'bg-secondary text-secondary-foreground'
                  : 'hover:bg-muted',
              )}
            >
              <span className="font-medium leading-tight">{hit.title}</span>
              {hit.subtitle ? (
                <span className="text-muted-foreground text-xs leading-tight">
                  {hit.subtitle}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
