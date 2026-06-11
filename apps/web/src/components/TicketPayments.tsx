import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Receipt, Trash2 } from 'lucide-react';
import type { PaymentMethod } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { kopecksToRub } from '../lib/money';
import { ConfirmDialog } from './ui/ConfirmDialog';

interface Props {
  ticketId: string;
  canManage: boolean;
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Наличные',
  card: 'Карта',
  bank_transfer: 'Безнал',
};

const paymentSchema = z.object({
  amountRub: z
    .number({ invalid_type_error: 'Введите сумму' })
    .int('Сумма должна быть целой')
    .positive('Сумма должна быть больше 0'),
  method: z.enum(['cash', 'card', 'bank_transfer']),
  comment: z.string().trim().max(500),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;

export function TicketPayments({ ticketId, canManage }: Props) {
  const utils = trpc.useUtils();
  const list = trpc.payments.listByTicket.useQuery({ ticketId });
  const totals = trpc.payments.getTotals.useQuery({ ticketId });

  const invalidate = () => {
    void utils.payments.listByTicket.invalidate({ ticketId });
    void utils.payments.getTotals.invalidate({ ticketId });
    void utils.workOrders.getByTicket.invalidate({ ticketId });
  };

  const add = trpc.payments.add.useMutation({ onSuccess: invalidate });
  const remove = trpc.payments.delete.useMutation({
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
    },
  });

  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    amountKopecks: string;
  } | null>(null);

  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { amountRub: 0, method: 'cash', comment: '' },
  });

  const onSubmit = (values: PaymentFormValues) => {
    setError(null);
    add.mutate(
      {
        ticketId,
        amountRub: values.amountRub,
        method: values.method,
        comment: values.comment ? values.comment : null,
      },
      {
        onSuccess: () => {
          form.reset({ amountRub: 0, method: 'cash', comment: '' });
        },
        onError: (err) => setError(err.message),
      },
    );
  };

  const paid = totals.data?.paidAmountKopecks ?? '0';
  const total = totals.data?.totalAmountKopecks ?? '0';
  const due = (BigInt(total) - BigInt(paid)).toString();

  return (
    <div className="space-y-4">
      <div className="bg-muted/30 grid grid-cols-3 gap-3 rounded-lg p-3 text-sm">
        <Stat label="Итого по наряду" value={kopecksToRub(total)} accent={false} />
        <Stat label="Оплачено" value={kopecksToRub(paid)} accent={false} />
        <Stat label="К доплате" value={kopecksToRub(due)} accent={BigInt(due) > 0n} />
      </div>

      {canManage && (
        <form
          onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
          className="bg-card rounded-lg border p-3"
        >
          <h3 className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold">
            <Receipt className="h-4 w-4" />
            Внести платёж
          </h3>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
            <input
              type="number"
              step="1"
              min="0"
              {...form.register('amountRub', { valueAsNumber: true })}
              placeholder="Сумма ₽"
              className="bg-background rounded-md border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
              required
            />
            <select
              {...form.register('method')}
              className="bg-background rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="cash">Наличные</option>
              <option value="card">Карта</option>
              <option value="bank_transfer">Безнал</option>
            </select>
            <input
              type="text"
              {...form.register('comment')}
              placeholder="Комментарий"
              className="bg-background rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              type="submit"
              disabled={add.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md px-3 py-2 text-sm font-medium transition"
            >
              {add.isPending ? 'Сохраняем…' : 'Внести'}
            </button>
          </div>
          {form.formState.errors.amountRub && (
            <div className="text-destructive mt-2 text-xs">
              {form.formState.errors.amountRub.message}
            </div>
          )}
          {error && <div className="text-destructive mt-2 text-sm">{error}</div>}
        </form>
      )}

      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="border-b p-3">
          <h3 className="text-sm font-semibold">История платежей</h3>
        </div>
        {list.isLoading ? (
          <div className="text-muted-foreground p-4 text-center text-sm">Загрузка…</div>
        ) : list.data && list.data.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Дата</th>
                <th className="px-3 py-2 text-left font-medium">Метод</th>
                <th className="px-3 py-2 text-right font-medium">Сумма ₽</th>
                <th className="px-3 py-2 text-left font-medium">Комментарий</th>
                {canManage && <th className="px-2 py-2"></th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.data.map((p) => (
                <tr key={p.id} className="hover:bg-muted/20 transition">
                  <td className="text-muted-foreground px-3 py-2 text-xs tabular-nums">
                    {p.paidAt.toLocaleString('ru-RU')}
                  </td>
                  <td className="px-3 py-2">{METHOD_LABEL[p.method]}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {kopecksToRub(p.amountKopecks)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">{p.comment ?? '—'}</td>
                  {canManage && (
                    <td className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() =>
                          setDeleteTarget({ id: p.id, amountKopecks: p.amountKopecks })
                        }
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="Удалить платёж"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-muted-foreground p-4 text-center text-sm">Платежей пока нет</div>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Удалить платёж"
        description={
          deleteTarget
            ? `Платёж на ${kopecksToRub(deleteTarget.amountKopecks)} ₽ будет удалён. Это действие необратимо.`
            : undefined
        }
        confirmText="Удалить"
        variant="danger"
        loading={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate({ id: deleteTarget.id });
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: boolean }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs uppercase">{label}</div>
      <div
        className={cn(
          'mt-1 font-semibold tabular-nums',
          accent ? 'text-warning text-lg' : 'text-base',
        )}
      >
        {value}
      </div>
    </div>
  );
}
