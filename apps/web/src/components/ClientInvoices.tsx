import { Link } from 'wouter';
import { Receipt } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub } from '../lib/money';
import { QueryError } from './QueryError';
import { StatusBadge } from './ui/StatusBadge';
import { INVOICE_STATUS_META } from '../lib/dictionaries';
import { clientDebtKopecks } from '../lib/client-debt';

/**
 * Счета клиента и его долг — на карточке самого клиента.
 *
 * Раньше карточка показывала реквизиты, контакты и технику, но не деньги: на
 * вопрос «сколько эта больница нам должна» приходилось идти в «Дебиторку» и
 * искать там нужную строку среди всех. `invoices.listByClient` существует
 * с самого начала.
 *
 * Долг считается по общему списку статусов «счёт с остатком» из `@erfolg/shared`
 * — тому же, из которого собран SQL дебиторки и плитки «Вам должны».
 */
export function ClientInvoices({ clientId }: { clientId: string }) {
  const q = trpc.invoices.listByClient.useQuery({ clientId }, { enabled: !!clientId });
  const list = q.data ?? [];
  const debt = clientDebtKopecks(list);

  return (
    <section className="bg-card rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 md:p-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
          <Receipt className="h-4 w-4" />
          Счета ({list.length})
        </h2>
        {list.length > 0 &&
          (debt > 0 ? (
            <span className="text-destructive text-sm font-semibold tabular-nums">
              Долг: {formatRub(debt)}
            </span>
          ) : (
            <span className="text-success text-sm font-medium">Долга нет</span>
          ))}
      </div>

      {q.error ? (
        <QueryError
          error={q.error}
          paused={q.fetchStatus === 'paused'}
          what="счета клиента"
          onRetry={() => void q.refetch()}
          className="m-4"
        />
      ) : q.isLoading ? (
        <div className="text-muted-foreground p-8 text-center text-sm">Загрузка…</div>
      ) : list.length === 0 ? (
        <div className="text-muted-foreground p-8 text-center text-sm">
          Счетов по этому клиенту нет
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Номер</th>
              <th className="px-3 py-2 text-left font-medium">Выставлен</th>
              <th className="px-3 py-2 text-left font-medium">Оплатить до</th>
              <th className="px-3 py-2 text-right font-medium">Сумма</th>
              <th className="px-3 py-2 text-right font-medium">Оплачено</th>
              <th className="px-3 py-2 text-left font-medium">Статус</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.map((i) => {
              const meta = INVOICE_STATUS_META[i.status];
              return (
                <tr key={i.id} className="hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <Link
                      href={`/invoices/${i.id}`}
                      className="text-foreground hover:text-primary font-medium"
                    >
                      {i.invoiceNumber}
                    </Link>
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">
                    {formatDate(i.issueDate)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">
                    {formatDate(i.dueDate)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatRub(i.totalAmountKopecks)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-right tabular-nums">
                    {formatRub(i.paidAmountKopecks)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge variant={meta.variant}>
                      {meta.shortLabel ?? meta.label}
                    </StatusBadge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Даты счёта приходят строкой YYYY-MM-DD. */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
}
