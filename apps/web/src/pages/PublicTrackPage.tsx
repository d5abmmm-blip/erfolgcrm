import { useRoute } from 'wouter';
import { Loader2, PackageSearch, ShieldCheck } from 'lucide-react';
import type { TrackTimeline } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { RepairTracker } from '../components/RepairTracker';

/**
 * Публичная страница отслеживания ремонта «как посылка» (фича №3).
 * Открывается по секрет-ссылке /track/:token БЕЗ логина. Показывает только
 * технический трек стадий (PII-free) — данные приходят с сервера уже собранными.
 */
export function PublicTrackPage() {
  const [, params] = useRoute<{ token: string }>('/track/:token');
  const token = params?.token ?? '';
  const q = trpc.track.getByToken.useQuery(
    { token },
    { enabled: Boolean(token), retry: false },
  );

  return (
    <div className="bg-muted/30 h-full w-full overflow-y-auto px-4 py-8">
      <div className="mx-auto w-full max-w-lg">
        {q.isLoading && (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
          </div>
        )}

        {!q.isLoading && (q.error || !q.data) && (
          <div className="bg-card rounded-xl border p-8 text-center">
            <PackageSearch className="text-muted-foreground mx-auto h-8 w-8" />
            <h1 className="mt-3 text-lg font-semibold">Ссылка не найдена</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Возможно, ссылка устарела или введена с ошибкой. Уточните её в сервисном центре.
            </p>
          </div>
        )}

        {!q.isLoading && q.data && (
          <>
            <div className="mb-4 flex items-center gap-2">
              <PackageSearch className="text-primary h-5 w-5" />
              <div>
                <div className="text-sm font-medium">Отслеживание ремонта</div>
                <div className="text-muted-foreground text-xs">{q.data.companyName}</div>
              </div>
            </div>

            <div className="bg-card rounded-xl border p-5 md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h1 className="text-lg font-semibold">Заявка № {q.data.ticketNumber}</h1>
                  <p className="text-muted-foreground text-sm">
                    {q.data.deviceLabel ?? 'Оборудование'}
                  </p>
                </div>
                <span className="bg-primary/10 text-primary rounded px-2 py-1 text-xs font-medium">
                  {stateLabel(q.data.timeline)}
                </span>
              </div>

              <div className="mt-5">
                <RepairTracker timeline={q.data.timeline} />
              </div>
            </div>

            <div className="text-muted-foreground mt-4 flex items-center justify-center gap-1.5 text-xs">
              <ShieldCheck className="h-3.5 w-3.5" />
              Ссылка предоставлена сервисным центром
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function stateLabel(timeline: TrackTimeline): string {
  if (timeline.cancelled) return 'Отменена';
  return timeline.stages[timeline.currentIndex]?.label ?? 'В работе';
}
