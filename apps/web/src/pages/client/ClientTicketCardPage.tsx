import { useRoute, Link } from 'wouter';
import { Loader2, ArrowLeft } from 'lucide-react';
import type { TicketStatus } from '@erfolg/shared';
import { buildTrackTimeline } from '@erfolg/shared';
import { trpc } from '../../lib/trpc';
import { RepairTracker } from '../../components/RepairTracker';

/** Понятная клиенту подпись текущего состояния для «пилюли» в шапке. */
function currentStateLabel(timeline: ReturnType<typeof buildTrackTimeline>): string {
  if (timeline.cancelled) return 'Отменена';
  const stage = timeline.stages[timeline.currentIndex];
  return stage?.label ?? 'В работе';
}

export function ClientTicketCardPage() {
  const [, params] = useRoute<{ id: string }>('/client/tickets/:id');
  const id = params?.id ?? '';
  const q = trpc.clientCabinet.getTicket.useQuery({ id }, { enabled: Boolean(id) });

  if (q.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className="space-y-3 p-6">
        <BackLink />
        <div className="text-destructive text-sm">Заявка не найдена</div>
      </div>
    );
  }
  const t = q.data;
  const timeline = buildTrackTimeline({
    status: t.status as TicketStatus,
    receivedAt: t.receivedAt,
    closedAt: t.closedAt,
    cancelledAt: t.cancelledAt,
    waitingForPart: t.waitingForPart,
    events: t.events,
  });

  return (
    <div className="space-y-4 p-4 md:p-6">
      <BackLink />
      <div className="bg-card rounded-md border p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Заявка № {t.ticketNumber}</h2>
            <p className="text-muted-foreground text-sm">{t.assetModel ?? 'Без техники'}</p>
          </div>
          <span className="bg-primary/10 text-primary rounded px-2 py-1 text-xs font-medium">
            {currentStateLabel(timeline)}
          </span>
        </div>

        {t.symptom && (
          <div className="mt-4">
            <div className="text-muted-foreground text-xs">Описание проблемы</div>
            <div className="mt-0.5 whitespace-pre-wrap text-sm">{t.symptom}</div>
          </div>
        )}
        {t.engineerName && (
          <div className="mt-3">
            <div className="text-muted-foreground text-xs">Исполнитель</div>
            <div className="mt-0.5 text-sm">{t.engineerName}</div>
          </div>
        )}
      </div>

      <div className="bg-card rounded-md border p-4 md:p-6">
        <h3 className="mb-4 text-sm font-semibold">Стадия ремонта</h3>
        <RepairTracker timeline={timeline} />
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/client/tickets"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft className="h-4 w-4" />К списку
    </Link>
  );
}
