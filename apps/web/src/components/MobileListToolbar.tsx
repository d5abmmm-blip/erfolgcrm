import type { ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

/**
 * Липкая панель списка (/m/queue, /m/tasks): слева фильтры, справа «Обновить».
 *
 * top-0, а не top-14: скроллится НЕ окно, а <main> оболочки MobileShell
 * (html/body в globals.css с overflow:hidden), и его верх уже под шапкой.
 * С top-14 панель постоянно висела на 56px ниже своего места, наезжала на
 * баннер пуша, а в щели над ней просвечивал проскролливаемый контент.
 * Фон непрозрачный (bg-card) — контент уходит под панель, а не сквозь неё.
 */
export function MobileListToolbar({
  children,
  onRefresh,
  refreshing,
}: {
  children: ReactNode;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="bg-card sticky top-0 z-20 flex items-center justify-between gap-2 border-b px-3 py-2">
      {children}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Обновить"
        className="text-muted-foreground hover:text-foreground hover:bg-muted grid h-9 w-9 place-items-center rounded transition"
      >
        {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      </button>
    </div>
  );
}
