import { Loader2 } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { QueryError } from '../../components/QueryError';

const STATUS_LABEL: Record<string, string> = {
  in_service: 'В эксплуатации',
  in_repair: 'В ремонте',
  awaiting_parts: 'Ожидает запчасти',
  reserve: 'В резерве',
  decommissioned: 'Списано',
};

export function ClientAssetsPage() {
  const list = trpc.clientCabinet.listAssets.useQuery();

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
          what="список вашей техники"
          onRetry={() => void list.refetch()}
        />
      </div>
    );
  }
  if (!list.data || list.data.length === 0) {
    return (
      <div className="p-6">
        <div className="bg-card text-muted-foreground rounded-md border p-8 text-center text-sm">
          За вашей организацией ещё не закреплено ни одной единицы техники.
          Если вы только начали обслуживание — обратитесь в сервисный центр для регистрации.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="bg-card overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">Модель</th>
              <th className="px-3 py-2 text-left">Производитель</th>
              <th className="px-3 py-2 text-left">Серийный №</th>
              <th className="px-3 py-2 text-left">Инв. №</th>
              <th className="px-3 py-2 text-left">Где находится</th>
              <th className="px-3 py-2 text-left">Состояние</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.data.map((a) => (
              <tr key={a.id} className="hover:bg-muted/30">
                <td className="px-3 py-2 font-medium">{a.model}</td>
                <td className="px-3 py-2 text-muted-foreground">{a.manufacturer ?? '—'}</td>
                <td className="px-3 py-2">{a.serialNumber ?? '—'}</td>
                <td className="px-3 py-2">{a.inventoryNumber ?? '—'}</td>
                <td className="px-3 py-2 text-muted-foreground">{a.location ?? '—'}</td>
                <td className="px-3 py-2">
                  <span className="bg-muted text-muted-foreground rounded px-2 py-0.5 text-xs">
                    {STATUS_LABEL[a.lifecycleStatus] ?? a.lifecycleStatus}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
