import { cn } from '../../lib/utils';

interface PaginationProps {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  className?: string;
}

/**
 * Пагинация: ←/→ + индикатор «Стр N из M · всего T».
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

  return (
    <div
      className={cn(
        'text-muted-foreground flex items-center justify-between text-xs',
        className,
      )}
    >
      <div>
        Страница {page} из {totalPages} · всего {total}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Предыдущая страница"
          disabled={page === 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          className="hover:bg-muted disabled:opacity-40 rounded-md border px-2 py-1 transition"
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Следующая страница"
          disabled={page >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          className="hover:bg-muted disabled:opacity-40 rounded-md border px-2 py-1 transition"
        >
          →
        </button>
      </div>
    </div>
  );
}
