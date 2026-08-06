import { Loader2 } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { QueryError } from '../../components/QueryError';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик',
  active: 'Действует',
  expired: 'Истёк',
  terminated: 'Расторгнут',
};
const TYPE_LABEL: Record<string, string> = {
  service: 'Сервисный',
  one_time: 'Разовый',
};

export function ClientContractsPage() {
  const list = trpc.clientCabinet.listContracts.useQuery();

  if (list.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (list.error) {
    return (
      <div className="p-6">
        <QueryError
          error={list.error}
          paused={list.fetchStatus === 'paused'}
          what="список договоров"
          onRetry={() => void list.refetch()}
        />
      </div>
    );
  }
  if (!list.data || list.data.length === 0) {
    return (
      <div className="p-6">
        <div className="bg-card text-muted-foreground rounded-md border p-8 text-center text-sm">
          Договоров пока нет
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <div className="bg-card overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">№ договора</th>
              <th className="px-3 py-2 text-left">Дата</th>
              <th className="px-3 py-2 text-left">Тип</th>
              <th className="px-3 py-2 text-left">Действует</th>
              <th className="px-3 py-2 text-left">Статус</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.data.map((c) => (
              <tr key={c.id} className="hover:bg-muted/30">
                <td className="px-3 py-2 font-medium">{c.contractNumber}</td>
                <td className="text-muted-foreground px-3 py-2">{c.contractDate}</td>
                <td className="px-3 py-2">{TYPE_LABEL[c.type] ?? c.type}</td>
                <td className="text-muted-foreground px-3 py-2">
                  {c.validFrom ?? '—'} … {c.validUntil ?? '—'}
                </td>
                <td className="px-3 py-2">
                  <span className="bg-primary/10 text-primary rounded px-2 py-0.5 text-xs">
                    {STATUS_LABEL[c.status] ?? c.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-muted-foreground mt-3 text-xs">
        Скачивание PDF договора появится в следующем обновлении кабинета.
      </p>
    </div>
  );
}
