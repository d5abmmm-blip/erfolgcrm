import { Loader2 } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { formatRub } from '../../lib/money';
import { formatDateRu } from '../../lib/format-date';
import { QueryError } from '../../components/QueryError';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик',
  issued: 'Выставлен',
  partially_paid: 'Частично оплачен',
  paid: 'Оплачен',
  overdue: 'Просрочен',
  cancelled: 'Отменён',
};
const STATUS_CLS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  issued: 'bg-primary/10 text-primary',
  partially_paid: 'bg-warning/15 text-warning',
  paid: 'bg-success/10 text-success',
  overdue: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

export function ClientInvoicesPage() {
  const list = trpc.clientCabinet.listInvoices.useQuery();

  if (list.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }
  // Плашка до ветки «Счетов пока нет»: клиент не должен принять сбой за отсутствие
  // долга — по неоплаченному счёту ему всё равно уйдёт напоминание.
  if (list.error) {
    return (
      <div className="p-6">
        <QueryError
          error={list.error}
          paused={list.fetchStatus === 'paused'}
          what="список счетов"
          onRetry={() => void list.refetch()}
        />
      </div>
    );
  }
  if (!list.data || list.data.length === 0) {
    return (
      <div className="p-6">
        <div className="bg-card text-muted-foreground rounded-md border p-8 text-center text-sm">
          Счетов пока нет
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
              <th className="px-3 py-2 text-left">№ счёта</th>
              <th className="px-3 py-2 text-left">Дата</th>
              <th className="px-3 py-2 text-left">Срок оплаты</th>
              <th className="px-3 py-2 text-right">Сумма</th>
              <th className="px-3 py-2 text-right">Оплачено</th>
              <th className="px-3 py-2 text-left">Статус</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.data.map((i) => (
              <tr key={i.id} className="hover:bg-muted/30">
                <td className="px-3 py-2 font-medium">{i.invoiceNumber}</td>
                <td className="text-muted-foreground px-3 py-2">{formatDateRu(i.issueDate)}</td>
                <td className="text-muted-foreground px-3 py-2">{formatDateRu(i.dueDate)}</td>
                <td className="px-3 py-2 text-right font-medium">
                  {formatRub(i.totalAmountKopecks)}
                </td>
                <td className="text-muted-foreground px-3 py-2 text-right">
                  {formatRub(i.paidAmountKopecks)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${STATUS_CLS[i.status] ?? 'bg-muted text-muted-foreground'}`}
                  >
                    {STATUS_LABEL[i.status] ?? i.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-muted-foreground mt-3 text-xs">
        Скачивание PDF счёта появится в следующем обновлении кабинета. Пока — обратитесь в сервисный
        центр.
      </p>
    </div>
  );
}
