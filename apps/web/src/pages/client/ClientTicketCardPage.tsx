import { useRoute, Link } from 'wouter';
import { Loader2, ArrowLeft } from 'lucide-react';
import { trpc } from '../../lib/trpc';

const STATUS_LABEL: Record<string, string> = {
  received: 'Принята',
  diagnostics: 'Диагностика',
  estimate: 'Смета',
  approval: 'Согласование',
  in_progress: 'В работе',
  act_pending: 'Ожидает акта',
  closed: 'Закрыта',
  cancelled: 'Отменена',
};
const EVENT_LABEL: Record<string, string> = {
  created: 'Заявка создана',
  status_change: 'Изменён статус',
  assignment_change: 'Назначен исполнитель',
  priority_change: 'Изменён приоритет',
  sla_change: 'Изменён SLA',
  note: 'Комментарий',
  document_printed: 'Распечатан документ',
};

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

  return (
    <div className="space-y-4 p-4 md:p-6">
      <BackLink />
      <div className="bg-card rounded-md border p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Заявка № {t.ticketNumber}</h2>
            <p className="text-muted-foreground text-sm">
              {t.assetModel ?? 'Без техники'}
            </p>
          </div>
          <span className="bg-primary/10 text-primary rounded px-2 py-1 text-xs font-medium">
            {STATUS_LABEL[t.status] ?? t.status}
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <Row label="Принята">
            {new Intl.DateTimeFormat('ru-RU', {
              dateStyle: 'short',
              timeStyle: 'short',
            }).format(new Date(t.receivedAt))}
          </Row>
          <Row label="Закрыта">
            {t.closedAt
              ? new Intl.DateTimeFormat('ru-RU', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                }).format(new Date(t.closedAt))
              : '—'}
          </Row>
          <Row label="Исполнитель">{t.engineerName ?? 'Ещё не назначен'}</Row>
          <Row label="Описание проблемы" full>
            <span className="whitespace-pre-wrap">{t.symptom ?? '—'}</span>
          </Row>
        </dl>
      </div>

      <div className="bg-card rounded-md border p-4 md:p-6">
        <h3 className="text-sm font-semibold">Хронология</h3>
        {t.events.length === 0 ? (
          <div className="text-muted-foreground mt-3 text-sm">Событий пока нет</div>
        ) : (
          <ol className="mt-3 space-y-3">
            {t.events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <div className="bg-primary/10 text-primary mt-0.5 h-2 w-2 shrink-0 rounded-full" />
                <div className="flex-1 text-sm">
                  <div className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</div>
                  <div className="text-muted-foreground text-xs">
                    {new Intl.DateTimeFormat('ru-RU', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }).format(new Date(e.createdAt))}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
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

function Row({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? 'md:col-span-2' : ''}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
