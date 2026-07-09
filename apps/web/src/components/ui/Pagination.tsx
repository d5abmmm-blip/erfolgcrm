import { useState } from 'react';
import { cn } from '../../lib/utils';

interface PaginationProps {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  className?: string;
}

type PageItem = number | 'left-ellipsis' | 'right-ellipsis';

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i += 1) out.push(i);
  return out;
}

/**
 * Список кнопок-страниц вокруг текущей: «первая … соседи … последняя».
 * siblingCount — сколько страниц показывать по обе стороны от текущей.
 * Пример (239 страниц): стр.1 → 1 2 3 4 5 … 239; стр.120 → 1 … 119 120 121 … 239.
 */
function pageItems(page: number, totalPages: number, siblingCount = 1): PageItem[] {
  // первая + последняя + текущая + 2 многоточия + соседи по обе стороны
  const totalSlots = siblingCount * 2 + 5;
  if (totalPages <= totalSlots) return range(1, totalPages);

  const leftSibling = Math.max(page - siblingCount, 1);
  const rightSibling = Math.min(page + siblingCount, totalPages);

  // Многоточие показываем, только если оно прячет ≥2 страниц; иначе выводим саму страницу.
  const showLeftEllipsis = leftSibling > 3;
  const showRightEllipsis = rightSibling < totalPages - 2;

  if (!showLeftEllipsis && showRightEllipsis) {
    const leftCount = 3 + 2 * siblingCount;
    return [...range(1, leftCount), 'right-ellipsis', totalPages];
  }
  if (showLeftEllipsis && !showRightEllipsis) {
    const rightCount = 3 + 2 * siblingCount;
    return [1, 'left-ellipsis', ...range(totalPages - rightCount + 1, totalPages)];
  }
  return [1, 'left-ellipsis', ...range(leftSibling, rightSibling), 'right-ellipsis', totalPages];
}

/**
 * Пагинация: ←/→ + кликабельные номера страниц с многоточиями,
 * индикатор «Страница N из M · всего T» и поле «перейти к странице» для длинных списков.
 * Отображается только если total > pageSize.
 */
export function Pagination({
  page,
  total,
  pageSize,
  onPageChange,
  className,
}: PaginationProps) {
  if (total <= pageSize) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = pageItems(page, totalPages);

  const go = (p: number) => {
    const next = Math.min(totalPages, Math.max(1, p));
    if (next !== page) onPageChange(next);
  };

  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs',
        className,
      )}
    >
      <div>
        Страница {page} из {totalPages} · всего {total}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <button
          type="button"
          aria-label="Предыдущая страница"
          disabled={page === 1}
          onClick={() => go(page - 1)}
          className="hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent rounded-md border px-2 py-1 transition"
        >
          ←
        </button>

        {items.map((item) =>
          typeof item === 'number' ? (
            <button
              key={item}
              type="button"
              aria-label={`Страница ${item}`}
              aria-current={item === page ? 'page' : undefined}
              onClick={() => go(item)}
              className={cn(
                'min-w-[2rem] rounded-md border px-2 py-1 text-center tabular-nums transition',
                item === page
                  ? 'border-primary bg-primary text-primary-foreground font-medium'
                  : 'hover:bg-muted',
              )}
            >
              {item}
            </button>
          ) : (
            <span key={item} className="select-none px-1" aria-hidden>
              …
            </span>
          ),
        )}

        <button
          type="button"
          aria-label="Следующая страница"
          disabled={page >= totalPages}
          onClick={() => go(page + 1)}
          className="hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent rounded-md border px-2 py-1 transition"
        >
          →
        </button>

        {totalPages > 7 && <JumpToPage totalPages={totalPages} onGo={go} />}
      </div>
    </div>
  );
}

/** Быстрый переход к странице по номеру — полезно для длинных списков (сотни страниц). */
function JumpToPage({
  totalPages,
  onGo,
}: {
  totalPages: number;
  onGo: (p: number) => void;
}) {
  const [value, setValue] = useState('');

  const submit = () => {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) onGo(n);
    setValue('');
  };

  return (
    <span className="ml-1 hidden items-center gap-1 sm:inline-flex">
      <span>стр.</span>
      <input
        type="number"
        min={1}
        max={totalPages}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder="№"
        aria-label="Перейти к странице"
        className="bg-background focus:ring-primary/40 w-14 rounded-md border px-1.5 py-1 text-center tabular-nums outline-none focus:ring-2"
      />
    </span>
  );
}
