import { useState } from 'react';
import { Link } from 'wouter';
import { Loader2, Plus } from 'lucide-react';
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
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Все' },
  ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
];

export function ClientTicketsPage() {
  const [status, setStatus] = useState('');
  const list = trpc.clientCabinet.listTickets.useQuery({
    status: status || undefined,
  });

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Статус:</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <Link
          href="/client/tickets/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          Создать заявку
        </Link>
      </div>

      {list.isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        </div>
      ) : list.data && list.data.length > 0 ? (
        <div className="bg-card overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left">№</th>
                <th className="px-3 py-2 text-left">Техника</th>
                <th className="px-3 py-2 text-left">Описание</th>
                <th className="px-3 py-2 text-left">Принята</th>
                <th className="px-3 py-2 text-left">Статус</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.data.map((t) => (
                <tr key={t.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <Link href={`/client/tickets/${t.id}`} className="text-primary hover:underline">
                      {t.ticketNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {t.assetModel ?? '—'}
                  </td>
                  <td className="px-3 py-2 max-w-md truncate">{t.symptom ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">
                    {new Intl.DateTimeFormat('ru-RU').format(new Date(t.receivedAt))}
                  </td>
                  <td className="px-3 py-2">
                    <span className="bg-primary/10 text-primary rounded px-2 py-0.5 text-xs">
                      {STATUS_LABEL[t.status] ?? t.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-card text-muted-foreground rounded-md border p-8 text-center text-sm">
          Заявок не найдено
        </div>
      )}
    </div>
  );
}
