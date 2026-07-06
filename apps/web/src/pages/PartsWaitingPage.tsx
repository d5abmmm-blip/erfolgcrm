/**
 * Фича №7 — «Лист ожидания запчастей».
 *
 * Один экран: активные заявки, которые стоят из-за детали (флаг «Ждём запчасть»).
 * Дольше всех — сверху. Просроченные (стоит ≥ OVERDUE_DAYS дней) подсвечены красным.
 * Клик по строке открывает заявку. Данные — tickets.partsWaiting (без миграции).
 */
import { Link } from 'wouter';
import { Hourglass, PackageX } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

/** Порог «просрочено»: заявка стоит из-за детали столько дней и дольше → красным. */
const OVERDUE_DAYS = 7;
const POLL_INTERVAL_MS = 60_000;

/** Русское склонение «день/дня/дней». */
function daysWord(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

function waitingLabel(days: number): string {
  if (days <= 0) return 'меньше суток';
  return `стоит ${days} ${daysWord(days)}`;
}

export function PartsWaitingPage() {
  const q = trpc.tickets.partsWaiting.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const items = q.data ?? [];
  const overdueCount = items.filter((i) => i.daysWaiting >= OVERDUE_DAYS).length;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Hourglass className="h-5 w-5" /> Ожидание запчастей
        </h1>
        <p className="text-muted-foreground text-sm">
          Заявки, которые стоят из-за детали. Дольше всех — сверху.
        </p>
      </div>

      {q.isLoading ? (
        <div className="text-muted-foreground text-sm">Загрузка…</div>
      ) : q.error ? (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm">
          Не удалось загрузить: {q.error.message}
        </div>
      ) : items.length === 0 ? (
        <div className="bg-muted/40 flex flex-col items-center gap-2 rounded-lg border p-8 text-center">
          <PackageX className="text-muted-foreground h-8 w-8" />
          <div className="text-sm font-medium">Сейчас ничего не ждёт запчасть</div>
          <div className="text-muted-foreground text-xs">
            Заявки появятся здесь, когда включите флаг «Ждём запчасть» на карточке заявки.
          </div>
        </div>
      ) : (
        <>
          <div className="text-muted-foreground text-sm">
            Стоят из-за детали: <span className="text-foreground font-medium">{items.length}</span>
            {overdueCount > 0 && (
              <>
                {' · '}
                <span className="text-destructive font-medium">
                  просрочено: {overdueCount} (от {OVERDUE_DAYS} дней)
                </span>
              </>
            )}
          </div>

          <div className="space-y-2">
            {items.map((i) => {
              const isOverdue = i.daysWaiting >= OVERDUE_DAYS;
              return (
                <Link
                  key={i.id}
                  href={`/tickets/${i.id}`}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border p-3 transition',
                    isOverdue
                      ? 'border-destructive/30 bg-destructive/5 hover:bg-destructive/10'
                      : 'bg-card hover:bg-muted/50',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {i.ticketNumber} · {i.clientDisplayName || '—'}
                    </div>
                    <div className="text-muted-foreground truncate text-xs">
                      {i.assetModel ?? 'техника не указана'}
                      {' · '}
                      {i.waitingForPartNote ? (
                        <span className="text-foreground">{i.waitingForPartNote}</span>
                      ) : (
                        <span className="italic">деталь не указана</span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div
                      className={cn(
                        'text-sm font-semibold',
                        isOverdue ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {waitingLabel(i.daysWaiting)}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {i.assignedEngineerName ?? '—'}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
