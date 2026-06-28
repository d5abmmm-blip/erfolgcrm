/**
 * /invoices/:id — карточка счёта на оплату.
 *
 * RBAC:
 *   - Просмотр — engineer+
 *   - Действия (выставить / отменить / удалить / редактировать notes) — staff (director + dispatcher)
 */
import { useEffect, useState } from 'react';
import { Link, useRoute } from 'wouter';
import { ChevronLeft, FileText, Printer, Trash2, XCircle } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { trpc } from '../lib/trpc';
import { formatRub } from '../lib/money';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { PromptDialog } from '../components/ui/PromptDialog';
import { StatusBadge } from '../components/ui/StatusBadge';
import { INVOICE_STATUS_META } from '../lib/dictionaries';
import {
  invoiceNotesSchema,
  type InvoiceNotesValues,
} from './InvoiceCardPage.schemas';

const VAT_LABEL: Record<string, string> = {
  '0': '0%',
  '5': '5%',
  '10': '10%',
  '20': '20%',
  without_vat: 'Без НДС',
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('ru-RU');
}

function formatDateTime(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('ru-RU');
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{value ?? '—'}</dd>
    </div>
  );
}

type DialogState =
  | { kind: 'none' }
  | { kind: 'cancel' }
  | { kind: 'delete' }
  | { kind: 'pdf-error'; message: string };

export function InvoiceCardPage() {
  const [, params] = useRoute('/invoices/:id');
  const id = params?.id ?? '';

  const me = trpc.auth.me.useQuery();
  const role = me.data?.user.role;
  const canEdit = role === 'director' || role === 'dispatcher';

  const utils = trpc.useUtils();

  const inv = trpc.invoices.getById.useQuery({ id }, { enabled: !!id });

  // Payments filtered by invoiceId from ticket payments list.
  const payments = trpc.payments.listByTicket.useQuery(
    { ticketId: inv.data?.ticketId ?? '' },
    { enabled: !!inv.data?.ticketId },
  );
  const invoicePayments = (payments.data ?? []).filter((p) => p.invoiceId === id);

  const [editingNotes, setEditingNotes] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });

  const notesForm = useForm<InvoiceNotesValues>({
    resolver: zodResolver(invoiceNotesSchema),
    defaultValues: { notes: '' },
  });

  // Re-sync RHF default when data arrives or notes editing starts.
  useEffect(() => {
    if (editingNotes) {
      notesForm.reset({ notes: inv.data?.notes ?? '' });
    }
  }, [editingNotes, inv.data?.notes, notesForm]);

  const invalidate = async () => {
    await utils.invoices.getById.invalidate({ id });
    await utils.invoices.listForTenant.invalidate();
    await utils.invoices.listByTicket.invalidate({ ticketId: inv.data?.ticketId });
  };

  const issue = trpc.invoices.issue.useMutation({
    onSuccess: invalidate,
    onError: (e) => setActionError(e.message),
  });
  const cancel = trpc.invoices.cancel.useMutation({
    onSuccess: async () => {
      setDialog({ kind: 'none' });
      await invalidate();
    },
    onError: (e) => {
      setDialog({ kind: 'none' });
      setActionError(e.message);
    },
  });
  const deleteDraft = trpc.invoices.deleteDraft.useMutation({
    onSuccess: async () => {
      setDialog({ kind: 'none' });
      await utils.invoices.listForTenant.invalidate();
      window.history.back();
    },
    onError: (e) => {
      setDialog({ kind: 'none' });
      setActionError(e.message);
    },
  });
  const updateDraft = trpc.invoices.updateDraft.useMutation({
    onSuccess: async () => {
      setEditingNotes(false);
      await invalidate();
    },
    onError: (e) => setActionError(e.message),
  });

  const handlePrint = async () => {
    if (!inv.data) return;
    setPrinting(true);
    try {
      const [{ printInvoice }, { ERFOLG_FALLBACK }] = await Promise.all([
        import('../lib/pdf'),
        import('../lib/pdf/branding'),
      ]);
      // We need client + work order data for the PDF.
      // workOrder is fetched lazily inside the print routine.
      const workOrderQuery = await utils.workOrders.getByTicket.fetch({
        ticketId: inv.data.ticketId,
      });
      const clientQuery = await utils.clients.get.fetch({ id: inv.data.clientId });

      if (!workOrderQuery) {
        setDialog({ kind: 'pdf-error', message: 'Нельзя сформировать PDF: наряд не найден.' });
        return;
      }
      const primaryContact =
        clientQuery?.contacts.find((c) => c.isPrimary) ?? clientQuery?.contacts[0];
      const clientData = {
        displayName: clientQuery?.displayName ?? inv.data.clientId,
        inn: clientQuery?.inn ?? null,
        kpp: clientQuery?.kpp ?? null,
        ogrn: clientQuery?.ogrn ?? null,
        legalAddress: clientQuery?.legalAddress ?? null,
        contactName: primaryContact?.fullName ?? null,
        contactPosition: primaryContact?.position ?? null,
      };
      const ticketQuery = await utils.tickets.get.fetch({ id: inv.data.ticketId });
      const ticketData = {
        ticketNumber: ticketQuery?.ticketNumber ?? inv.data.ticketId,
        receivedAt: ticketQuery?.receivedAt
          ? ticketQuery.receivedAt instanceof Date
            ? ticketQuery.receivedAt.toISOString()
            : String(ticketQuery.receivedAt)
          : new Date().toISOString(),
        repairType:
          (ticketQuery?.repairType) ?? 'paid',
        symptom: ticketQuery?.symptom ?? null,
        barcode: ticketQuery?.barcode ?? inv.data.ticketId,
      };
      await printInvoice({
        tenant: { ...ERFOLG_FALLBACK },
        client: clientData,
        ticket: ticketData,
        workOrder: {
          // Итог и ставка НДС берутся из «замороженного» снимка счёта (зафиксированы при
          // выставлении), а НЕ из живого наряда — иначе после правки наряда суммы в PDF
          // разойдутся с уже выставленным счётом. Детализация строк — из наряда (best available).
          vatRate: inv.data.vatRate,
          worksAmountKopecks: Number(workOrderQuery.worksAmountKopecks),
          partsAmountKopecks: Number(workOrderQuery.partsAmountKopecks),
          expensesAmountKopecks: Number(workOrderQuery.expensesAmountKopecks),
          totalAmountKopecks: Number(inv.data.totalAmountKopecks),
          lines: workOrderQuery.lines.map((l) => ({
            lineType: l.lineType,
            name: l.name,
            unit: l.unit,
            quantity: Number(l.quantity),
            unitPriceKopecks: Number(l.unitPriceKopecks),
            amountKopecks: Number(l.amountKopecks),
          })),
        },
        invoiceNumber: inv.data.invoiceNumber,
        issueDate: inv.data.issueDate,
        dueDate: inv.data.dueDate,
      });
    } catch (err) {
      setDialog({
        kind: 'pdf-error',
        message: `Ошибка PDF: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setPrinting(false);
    }
  };

  if (inv.isLoading) {
    return <div className="text-muted-foreground p-8 text-center text-sm">Загрузка…</div>;
  }
  if (inv.error || !inv.data) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Link
          href="/invoices"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" />К списку счетов
        </Link>
        <div className="text-destructive mt-4">
          {inv.error?.message ?? 'Счёт не найден'}
        </div>
      </div>
    );
  }

  const data = inv.data;
  const meta = INVOICE_STATUS_META[data.status];
  const isDraft = data.status === 'draft';
  const canIssue = isDraft;
  const canCancel =
    data.status === 'draft' ||
    data.status === 'issued' ||
    data.status === 'partially_paid' ||
    data.status === 'overdue';
  const canDelete = isDraft;

  const onSubmitNotes = (values: InvoiceNotesValues) => {
    setActionError(null);
    updateDraft.mutate({ invoiceId: id, notes: values.notes });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <Link
        href="/invoices"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К списку счетов
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <FileText className="h-3.5 w-3.5" />
            Счёт на оплату
          </div>
          <h1 className="mt-0.5 font-mono text-xl font-semibold md:text-2xl">
            {data.invoiceNumber}
          </h1>
          <p className="text-muted-foreground text-sm">
            Заявка:{' '}
            <Link
              href={`/tickets/${data.ticketId}`}
              className="hover:text-primary underline-offset-4 hover:underline"
            >
              открыть
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>
          <button
            type="button"
            onClick={() => void handlePrint()}
            disabled={printing}
            className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            <Printer className="h-3.5 w-3.5" />
            {printing ? 'Готовлю…' : 'Печать PDF'}
          </button>
          {canEdit && canIssue && (
            <button
              type="button"
              disabled={issue.isPending}
              onClick={() => {
                setActionError(null);
                issue.mutate({ invoiceId: id });
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {issue.isPending ? 'Выставляю…' : 'Выставить счёт'}
            </button>
          )}
          {canEdit && canCancel && (
            <button
              type="button"
              disabled={cancel.isPending}
              onClick={() => setDialog({ kind: 'cancel' })}
              className="hover:bg-destructive/10 hover:text-destructive inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              <XCircle className="h-3.5 w-3.5" />
              {cancel.isPending ? 'Отменяю…' : 'Отменить счёт'}
            </button>
          )}
          {canEdit && canDelete && (
            <button
              type="button"
              disabled={deleteDraft.isPending}
              onClick={() => setDialog({ kind: 'delete' })}
              className="hover:bg-destructive/10 hover:text-destructive inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleteDraft.isPending ? 'Удаляю…' : 'Удалить черновик'}
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border px-4 py-2 text-sm">
          {actionError}
        </div>
      )}

      {/* Details */}
      <section className="bg-card rounded-lg border p-4 md:p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Реквизиты</h2>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm md:grid-cols-2 lg:grid-cols-3">
          <Row label="Дата выставления" value={formatDate(data.issueDate)} />
          <Row label="Срок оплаты" value={formatDate(data.dueDate)} />
          <Row label="НДС" value={VAT_LABEL[data.vatRate] ?? data.vatRate} />
          <Row
            label="Итого"
            value={<span className="font-semibold">{formatRub(data.totalAmountKopecks)}</span>}
          />
          <Row label="В т.ч. НДС" value={formatRub(data.vatAmountKopecks)} />
          <Row label="Оплачено" value={formatRub(data.paidAmountKopecks)} />
          {data.issuedAt && <Row label="Выставлен в" value={formatDateTime(data.issuedAt)} />}
          {data.paidAt && <Row label="Оплачен в" value={formatDateTime(data.paidAt)} />}
          {data.cancelledAt && (
            <Row label="Отменён в" value={formatDateTime(data.cancelledAt)} />
          )}
          {data.cancelReason && (
            <div className="md:col-span-2">
              <dt className="text-muted-foreground text-xs">Причина отмены</dt>
              <dd className="text-sm">{data.cancelReason}</dd>
            </div>
          )}
          {data.onecSyncedAt && (
            <Row label="Синхр. с 1С" value={formatDateTime(data.onecSyncedAt)} />
          )}
        </dl>
      </section>

      {/* Notes (через react-hook-form + zod) */}
      <section className="bg-card rounded-lg border p-4 md:p-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Заметки</h2>
          {canEdit && isDraft && !editingNotes && (
            <button
              type="button"
              onClick={() => setEditingNotes(true)}
              className="text-primary text-xs underline-offset-2 hover:underline"
            >
              Редактировать
            </button>
          )}
        </div>
        {editingNotes ? (
          <form onSubmit={(e) => void notesForm.handleSubmit(onSubmitNotes)(e)} className="space-y-2">
            <textarea
              {...notesForm.register('notes')}
              rows={3}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
            {notesForm.formState.errors.notes && (
              <div className="text-destructive text-xs">
                {notesForm.formState.errors.notes.message}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={updateDraft.isPending}
                className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {updateDraft.isPending ? 'Сохраняю…' : 'Сохранить'}
              </button>
              <button
                type="button"
                onClick={() => setEditingNotes(false)}
                className="hover:bg-muted rounded-md border px-3 py-1.5 text-xs"
              >
                Отмена
              </button>
            </div>
          </form>
        ) : (
          <p className="text-muted-foreground whitespace-pre-line text-sm">
            {data.notes?.trim() || 'Заметок нет'}
          </p>
        )}
      </section>

      {/* Payments linked to this invoice */}
      <section className="bg-card rounded-lg border p-4 md:p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">
          Платежи по счёту {invoicePayments.length > 0 ? `(${invoicePayments.length})` : ''}
        </h2>
        {payments.isLoading ? (
          <div className="text-muted-foreground text-sm">Загрузка…</div>
        ) : invoicePayments.length === 0 ? (
          <div className="text-muted-foreground text-sm">Платежей по этому счёту нет</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Дата</th>
                <th className="px-3 py-2 text-left font-medium">Способ</th>
                <th className="px-3 py-2 text-right font-medium">Сумма</th>
                <th className="px-3 py-2 text-left font-medium">Комментарий</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {invoicePayments.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 text-xs">
                    {formatDateTime(p.paidAt instanceof Date ? p.paidAt : new Date(p.paidAt))}
                  </td>
                  <td className="px-3 py-2 text-xs">{p.method}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatRub(p.amountKopecks)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">{p.comment ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Диалоги */}
      <PromptDialog
        open={dialog.kind === 'cancel'}
        title="Отменить счёт"
        description="Можно указать причину отмены — она сохранится в карточке счёта."
        label="Причина отмены"
        placeholder="Например: ошибка в реквизитах"
        confirmText="Отменить счёт"
        cancelText="Не отменять"
        variant="danger"
        loading={cancel.isPending}
        onConfirm={(reason) => {
          setActionError(null);
          cancel.mutate({
            invoiceId: id,
            reason: reason.trim() ? reason.trim() : undefined,
          });
        }}
        onCancel={() => setDialog({ kind: 'none' })}
      />

      <ConfirmDialog
        open={dialog.kind === 'delete'}
        title="Удалить черновик счёта"
        description="Это действие необратимо."
        confirmText="Удалить"
        variant="danger"
        loading={deleteDraft.isPending}
        onConfirm={() => {
          setActionError(null);
          deleteDraft.mutate({ invoiceId: id });
        }}
        onCancel={() => setDialog({ kind: 'none' })}
      />

      <ConfirmDialog
        open={dialog.kind === 'pdf-error'}
        title="Не удалось сформировать PDF"
        description={dialog.kind === 'pdf-error' ? dialog.message : undefined}
        confirmText="Понятно"
        cancelText="Закрыть"
        onConfirm={() => setDialog({ kind: 'none' })}
        onCancel={() => setDialog({ kind: 'none' })}
      />
    </div>
  );
}
