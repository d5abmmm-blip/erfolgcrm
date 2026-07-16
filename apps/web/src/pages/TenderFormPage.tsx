/**
 * /tenders/new и /tenders/:id — создание и карточка тендерного контракта.
 * Карточка: реквизиты + статус + платежи частями («оплачено X из Y, осталось Z»).
 * С кассой не связано: платежи здесь — учёт по контракту, а не операции кассы.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { ArrowLeft, Gavel, Loader2, Plus, Trash2, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub } from '../lib/money';
import { parsePositiveRub } from '../lib/cash-format';
import { ClientPicker } from '../components/ClientPicker';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { StatusBadge } from '../components/ui/StatusBadge';
import { TENDER_STATUS_META, type TenderStatus } from '../lib/dictionaries';

const today = () => new Date().toISOString().slice(0, 10);

function fmtDate(d: string | null): string {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}

export function TenderFormPage() {
  const [, navigate] = useLocation();
  const [matchEdit, params] = useRoute('/tenders/:id');
  const id = matchEdit && params?.id !== 'new' ? (params?.id ?? null) : null;
  const isEdit = id !== null;

  const utils = trpc.useUtils();
  const detail = trpc.tenders.get.useQuery({ id: id ?? '' }, { enabled: isEdit });

  const [clientId, setClientId] = useState<string | null>(null);
  const [clientName, setClientName] = useState('');
  const [contractNumber, setContractNumber] = useState('');
  const [purchaseNumber, setPurchaseNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [contractDate, setContractDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Платёж (форма добавления)
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(today());
  const [payNote, setPayNote] = useState('');

  const t = detail.data;

  useEffect(() => {
    if (t) {
      setClientId(t.clientId);
      setClientName(t.clientName ?? '');
      setContractNumber(t.contractNumber);
      setPurchaseNumber(t.purchaseNumber ?? '');
      setAmount((Number(BigInt(t.amountKopecks)) / 100).toString());
      setContractDate(t.contractDate);
      setDueDate(t.dueDate ?? '');
      setComment(t.comment ?? '');
    }
  }, [t]);

  const invalidate = () =>
    Promise.all([
      utils.tenders.list.invalidate(),
      utils.tenders.summary.invalidate(),
      id ? utils.tenders.get.invalidate({ id }) : Promise.resolve(),
    ]);

  const create = trpc.tenders.create.useMutation({
    onSuccess: async (r) => {
      await invalidate();
      navigate(`/tenders/${r.id}`);
    },
    onError: (e) => setError(e.message),
  });
  const update = trpc.tenders.update.useMutation({
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const setStatus = trpc.tenders.setStatus.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });
  const del = trpc.tenders.delete.useMutation({
    onSuccess: async () => {
      await invalidate();
      navigate('/tenders');
    },
    onError: (e) => {
      setDeleteOpen(false);
      setError(e.message);
    },
  });
  const addPayment = trpc.tenders.addPayment.useMutation({
    onSuccess: async () => {
      setPayAmount('');
      setPayNote('');
      setPayDate(today());
      setError(null);
      await invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const delPayment = trpc.tenders.deletePayment.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });

  const parsedAmount = parsePositiveRub(amount);
  const canSave = clientId !== null && contractNumber.trim().length > 0 && parsedAmount !== null;

  const submit = () => {
    setError(null);
    if (!canSave || parsedAmount === null || clientId === null) {
      setError('Заполните заказчика, № контракта и сумму.');
      return;
    }
    const payload = {
      clientId,
      contractNumber: contractNumber.trim(),
      purchaseNumber: purchaseNumber.trim() || null,
      amountRub: parsedAmount,
      contractDate,
      dueDate: dueDate || null,
      comment: comment.trim() || null,
    };
    if (isEdit && id) update.mutate({ id, ...payload });
    else create.mutate(payload);
  };

  const submitPayment = () => {
    if (!id) return;
    const rub = parsePositiveRub(payAmount);
    if (rub === null) {
      setError('Сумма платежа должна быть больше нуля.');
      return;
    }
    addPayment.mutate({ tenderId: id, amountRub: rub, paidOn: payDate, note: payNote.trim() || null });
  };

  const inputCls =
    'bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2';

  if (isEdit && detail.isLoading) {
    return <div className="text-muted-foreground p-6 text-sm">Загрузка…</div>;
  }
  if (isEdit && !detail.isLoading && !t) {
    return (
      <div className="p-6 text-sm">
        Тендер не найден.{' '}
        <Link href="/tenders" className="text-primary hover:underline">
          К списку
        </Link>
      </div>
    );
  }

  const rest = t ? BigInt(t.restKopecks) : 0n;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link
            href="/tenders"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> К списку тендеров
          </Link>
          <h1 className="mt-0.5 flex items-center gap-2 text-xl font-semibold md:text-2xl">
            <Gavel className="text-muted-foreground h-5 w-5" />
            {isEdit ? `Контракт ${t?.contractNumber ?? ''}` : 'Новый тендер'}
          </h1>
        </div>
        {isEdit && t && (
          <StatusBadge variant={TENDER_STATUS_META[t.status].variant}>
            {TENDER_STATUS_META[t.status].label}
          </StatusBadge>
        )}
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
          {error}
        </div>
      )}

      {/* Реквизиты */}
      <div className="bg-card space-y-3 rounded-lg border p-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Заказчик</label>
          {isEdit ? (
            <div className="bg-muted/50 rounded-md border px-3 py-2 text-sm font-medium">
              {clientName || t?.clientName || '—'}
            </div>
          ) : (
            <ClientPicker
              value={clientId}
              onChange={(cid, name) => {
                setClientId(cid || null);
                setClientName(name);
              }}
            />
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">№ контракта</label>
            <input
              type="text"
              value={contractNumber}
              onChange={(e) => setContractNumber(e.target.value)}
              placeholder="Например: КО-77/26 или № из ЕИС"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">№ закупки (необязательно)</label>
            <input
              type="text"
              value={purchaseNumber}
              onChange={(e) => setPurchaseNumber(e.target.value)}
              placeholder="Номер извещения в ЕИС"
              className={inputCls}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Сумма контракта, ₽</label>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Дата контракта</label>
            <input
              type="date"
              value={contractDate}
              onChange={(e) => setContractDate(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Срок исполнения</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Комментарий (необязательно)</label>
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className={inputCls}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          {isEdit ? (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="text-muted-foreground hover:text-destructive inline-flex items-center gap-1.5 text-sm"
            >
              <Trash2 className="h-4 w-4" /> Удалить тендер
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!canSave || create.isPending || update.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50"
          >
            {(create.isPending || update.isPending) && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? 'Сохранить' : 'Создать тендер'}
          </button>
        </div>
      </div>

      {/* Статус */}
      {isEdit && t && (
        <div className="bg-card space-y-2 rounded-lg border p-4">
          <label className="block text-sm font-medium">Статус</label>
          <select
            value={t.status}
            onChange={(e) => setStatus.mutate({ id: t.id, status: e.target.value as TenderStatus })}
            className={inputCls}
            disabled={setStatus.isPending}
          >
            {(Object.keys(TENDER_STATUS_META) as TenderStatus[]).map((st) => (
              <option key={st} value={st}>
                {TENDER_STATUS_META[st].label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Платежи */}
      {isEdit && t && (
        <div className="bg-card space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Оплата по контракту</h2>
            <div className="text-sm tabular-nums">
              <span className="text-success font-medium">{formatRub(t.paidKopecks)}</span>
              <span className="text-muted-foreground"> из {formatRub(t.amountKopecks)}</span>
              {t.status !== 'cancelled' && (
                <span className="text-muted-foreground">
                  {' '}
                  · осталось {formatRub(rest > 0n ? t.restKopecks : '0')}
                </span>
              )}
            </div>
          </div>

          {t.payments.length > 0 ? (
            <ul className="divide-y">
              {t.payments.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="text-muted-foreground w-24 shrink-0 tabular-nums">
                    {fmtDate(p.paidOn)}
                  </span>
                  <span className="w-32 shrink-0 text-right font-medium tabular-nums">
                    {formatRub(p.amountKopecks)}
                  </span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {p.note ?? ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => delPayment.mutate({ tenderId: t.id, paymentId: p.id })}
                    className="text-muted-foreground hover:text-destructive shrink-0"
                    aria-label="Удалить платёж"
                    title="Удалить платёж"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">Платежей пока нет.</p>
          )}

          {/* Добавить платёж */}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <input
              type="text"
              inputMode="decimal"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              placeholder="Сумма, ₽"
              className="bg-background focus:ring-primary/40 w-32 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
            <input
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
            <input
              type="text"
              value={payNote}
              onChange={(e) => setPayNote(e.target.value)}
              placeholder="Примечание: аванс, по акту №2…"
              className="bg-background focus:ring-primary/40 min-w-[160px] flex-1 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
            <button
              type="button"
              onClick={submitPayment}
              disabled={addPayment.isPending || parsePositiveRub(payAmount) === null}
              className="bg-success/12 text-success hover:bg-success/20 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {addPayment.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Платёж
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteOpen}
        title="Удалить тендер?"
        description="Контракт будет скрыт (мягкое удаление). Кассу это не затрагивает."
        confirmText="Удалить"
        variant="danger"
        loading={del.isPending}
        onConfirm={() => id && del.mutate({ id })}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}
