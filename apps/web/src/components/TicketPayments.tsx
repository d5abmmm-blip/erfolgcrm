import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Receipt, Trash2 } from 'lucide-react';
import type { PaymentMethod } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { kopecksToRub } from '../lib/money';
import { humanizeError, SILENT_ERROR } from '../lib/error-message';
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
  /**
   * Рубли с копейками. Зеркало серверной проверки в payments/router.ts —
   * счёт на 1 498,50 ₽ раньше нельзя было закрыть вообще.
   * Точнее копейки не принимаем: молчаливое округление вверх упёрлось бы
   * в ограничение базы «оплачено не больше суммы счёта».
   */
  amountRub: z
    .number({ invalid_type_error: 'Введите сумму' })
    .positive('Сумма должна быть больше 0')
    .refine(
      (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
      'Сумма не может быть точнее копейки',
    ),
  method: z.enum(['cash', 'card', 'bank_transfer']),
  comment: z.string().trim().max(500),
  /** Счёт, который гасит платёж. Пустая строка — платёж без счёта. */
  invoiceId: z.string(),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;

/**
 * Счета, которые ждут денег. Ровно этот набор попадает в дебиторку и именно по
 * нему робот шлёт напоминания (`invoices/repository.ts`, RECEIVABLE_INVOICE_STATUSES).
 * Черновик и отменённый оплатить нельзя — сервер их отклоняет.
 */
const PAYABLE_STATUSES = ['issued', 'partially_paid', 'overdue'] as const;

export const NO_INVOICE = '';

/** Счета заявки, которые ещё можно погасить платежом. */
export function payableInvoices<T extends { status: string }>(list: readonly T[]): T[] {
  return list.filter((i) => (PAYABLE_STATUSES as readonly string[]).includes(i.status));
}

/**
 * Какой счёт подставить в форму. Если ждёт денег ровно один — подставляем его:
 * это обычный случай (счёт по заявке один), и именно на нём терялась привязка.
 * Если счетов несколько — выбирает человек, угадывать нельзя.
 */
export function defaultInvoiceId(payable: readonly { id: string }[]): string {
  return payable.length === 1 ? payable[0]!.id : NO_INVOICE;
}

export function TicketPayments({ ticketId, canManage }: Props) {
  const utils = trpc.useUtils();
  const list = trpc.payments.listByTicket.useQuery({ ticketId });
  const totals = trpc.payments.getTotals.useQuery({ ticketId });
  const invoices = trpc.invoices.listByTicket.useQuery({ ticketId });

  /** Счета этой заявки, которые ещё ждут денег. */
  const payable = useMemo(() => payableInvoices(invoices.data ?? []), [invoices.data]);

  /** Номера счетов для истории платежей — включая уже оплаченные и отменённые. */
  const invoiceNumberById = useMemo(
    () => new Map((invoices.data ?? []).map((i) => [i.id, i.invoiceNumber])),
    [invoices.data],
  );

  const invalidate = () => {
    void utils.payments.listByTicket.invalidate({ ticketId });
    void utils.payments.getTotals.invalidate({ ticketId });
    void utils.workOrders.getByTicket.invalidate({ ticketId });
    // Статус счёта пересчитан на сервере — обновляем и счёт, и дебиторку,
    // иначе оплаченный счёт продолжит висеть в долгах на экране.
    void utils.invoices.listByTicket.invalidate({ ticketId });
    void utils.invoices.receivables.invalidate();
    void utils.invoices.listForTenant.invalidate();
  };

  const add = trpc.payments.add.useMutation({ onSuccess: invalidate, meta: SILENT_ERROR });
  const remove = trpc.payments.delete.useMutation({
    meta: SILENT_ERROR,
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
    defaultValues: { amountRub: 0, method: 'cash', comment: '', invoiceId: NO_INVOICE },
  });

  // Счёт по заявке обычно один — подставляем его сам, чтобы оплату не забыли
  // привязать. Раньше связь не заполнялась никогда: счёт оставался в долгах и
  // робот слал напоминания уже заплатившему клиенту.
  const { setValue } = form;
  const preselected = defaultInvoiceId(payable);
  useEffect(() => {
    if (preselected) setValue('invoiceId', preselected);
  }, [preselected, setValue]);

  const resetForm = () =>
    form.reset({ amountRub: 0, method: 'cash', comment: '', invoiceId: preselected });

  const onSubmit = (values: PaymentFormValues) => {
    setError(null);
    add.mutate(
      {
        ticketId,
        invoiceId: values.invoiceId ? values.invoiceId : null,
        amountRub: values.amountRub,
        method: values.method,
        comment: values.comment ? values.comment : null,
      },
      {
        onSuccess: resetForm,
        onError: (err) => setError(humanizeError(err)),
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

          {payable.length > 0 && (
            <label className="mb-2 block">
              <span className="text-muted-foreground text-xs font-medium">Гасит счёт</span>
              <select
                {...form.register('invoiceId')}
                className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              >
                {payable.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    Счёт {inv.invoiceNumber} — осталось{' '}
                    {kopecksToRub(
                      (BigInt(inv.totalAmountKopecks) - BigInt(inv.paidAmountKopecks)).toString(),
                    )}{' '}
                    ₽
                  </option>
                ))}
                <option value={NO_INVOICE}>Без счёта</option>
              </select>
              <span className="text-muted-foreground mt-1 block text-[11px]">
                Пока платёж не привязан к счёту, счёт считается неоплаченным и по нему уходят
                напоминания клиенту.
              </span>
            </label>
          )}

          <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
            <input
              type="number"
              step="0.01"
              min="0"
              {...form.register('amountRub', { valueAsNumber: true })}
              placeholder="Сумма ₽"
              className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2"
              required
            />
            <select
              {...form.register('method')}
              className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            >
              <option value="cash">Наличные</option>
              <option value="card">Карта</option>
              <option value="bank_transfer">Безнал</option>
            </select>
            <input
              type="text"
              {...form.register('comment')}
              placeholder="Комментарий"
              className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
            <button
              type="submit"
              disabled={add.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50"
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
                <th className="px-3 py-2 text-left font-medium">Счёт</th>
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
                  <td className="px-3 py-2 text-xs">
                    {p.invoiceId ? (
                      <span className="font-mono">{invoiceNumberById.get(p.invoiceId) ?? '—'}</span>
                    ) : (
                      <span className="text-muted-foreground">без счёта</span>
                    )}
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
        error={remove.error?.message ?? null}
        onConfirm={() => {
          if (deleteTarget) remove.mutate({ id: deleteTarget.id });
        }}
        onCancel={() => {
          setDeleteTarget(null);
          remove.reset();
        }}
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
