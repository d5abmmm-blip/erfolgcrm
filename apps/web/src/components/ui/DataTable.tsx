import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface Column<T> {
  /** Уникальный ключ колонки (для key в React и для логики). */
  key: string;
  /** Заголовок столбца. */
  label: string;
  /** Кастомный рендер ячейки. Если не задан — берётся row[key]. */
  render?: (row: T) => ReactNode;
  /** Доп. классы — например text-right, font-mono. */
  className?: string;
  /** Классы заголовка (text-right, etc.). */
  headerClassName?: string;
}

export interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  loading?: boolean;
  error?: { message: string } | null;
  emptyText?: string;
  onRowClick?: (row: T) => void;
  rowKey: (row: T) => string;
  /** Опциональные доп. классы строки в зависимости от данных. */
  rowClassName?: (row: T) => string;
}

/**
 * Универсальная табличка для list-страниц (клиенты, техника, контракты и т.п.).
 * Стилистика — единая (bg-card, hover:bg-muted/20). Уровни:
 *   loading → "Загрузка…"
 *   error   → "Ошибка: …"
 *   empty   → emptyText или "Записей нет"
 */
export function DataTable<T>({
  data,
  columns,
  loading,
  error,
  emptyText = 'Записей нет',
  onRowClick,
  rowKey,
  rowClassName,
}: DataTableProps<T>) {
  if (loading) {
    return (
      <section className="bg-card overflow-hidden rounded-lg border">
        <div className="text-muted-foreground p-8 text-center text-sm">Загрузка…</div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="bg-card overflow-hidden rounded-lg border">
        <div className="text-destructive p-6 text-sm">Ошибка: {error.message}</div>
      </section>
    );
  }
  if (data.length === 0) {
    return (
      <section className="bg-card overflow-hidden rounded-lg border">
        <div className="text-muted-foreground p-8 text-center text-sm">{emptyText}</div>
      </section>
    );
  }

  return (
    <section className="bg-card overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn('px-3 py-2 text-left font-medium', c.headerClassName)}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              // Клавиатурный доступ: строка фокусируется Tab'ом, открывается Enter/Space.
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              className={cn(
                'transition',
                onRowClick &&
                  'hover:bg-primary/[0.05] focus-visible:bg-primary/[0.05] cursor-pointer outline-none',
                rowClassName?.(row),
              )}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('px-3 py-2', c.className)}>
                  {c.render
                    ? c.render(row)
                    : ((row as Record<string, unknown>)[c.key] as ReactNode) ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
