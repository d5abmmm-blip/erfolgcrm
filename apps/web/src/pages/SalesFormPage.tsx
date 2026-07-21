/**
 * /sales/new и /sales/:id — создание/карточка продажи.
 * Карточка совмещает редактирование позиций, смену статуса и приём оплаты (в кассу).
 * Оплаченную продажу редактировать нельзя — сначала «Отменить оплату».
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { Check, ChevronLeft, Loader2, Plus, Trash2, Wallet } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub } from '../lib/money';
import { ClientPicker } from '../components/ClientPicker';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { StatusBadge } from '../components/ui/StatusBadge';
import { SALE_STATUS_META, type SaleStatus } from '../lib/dictionaries';
import { QueryError } from '../components/QueryError';

interface ItemRow {
  name: string;
  qtyStr: string;
  priceRubStr: string;
  costRubStr: string;
}

const inputCls =
  'border-input bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2';

const todayIso = () => new Date().toISOString().slice(0, 10);
const emptyRow = (): ItemRow => ({ name: '', qtyStr: '1', priceRubStr: '', costRubStr: '' });

export function SalesFormPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute('/sales/:id');
  const editId = params && params.id !== 'new' ? params.id : null;
  const isEdit = !!editId;
  const utils = trpc.useUtils();

  const existing = trpc.sales.get.useQuery({ id: editId ?? '' }, { enabled: isEdit });
  const accountsQ = trpc.cash.accounts.list.useQuery();
  const accounts = accountsQ.data ?? [];

  const [clientId, setClientId] = useState<string | null>(null);
  const [clientName, setClientName] = useState<string>('');
  const [supplier, setSupplier] = useState('');
  const [comment, setComment] = useState('');
  const [items, setItems] = useState<ItemRow[]>([emptyRow()]);
  const [hydrated, setHydrated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState(false);

  // payment form
  const [payAccountId, setPayAccountId] = useState('');
  const [payDate, setPayDate] = useState(todayIso());

  const sale = existing.data;
  const isPaid = !!sale?.isPaid;

  useEffect(() => {
    if (!sale || hydrated) return;
    setClientId(sale.clientId);
    setClientName(sale.clientName ?? '');
    setSupplier(sale.supplier ?? '');
    setComment(sale.comment ?? '');
    setItems(
      sale.items.length
        ? sale.items.map((i) => ({
            name: i.name,
            qtyStr: String(i.quantity),
            priceRubStr: (Number(i.unitPriceKopecks) / 100).toString(),
            costRubStr: i.unitCostKopecks && i.unitCostKopecks !== '0'
              ? (Number(i.unitCostKopecks) / 100).toString()
              : '',
          }))
        : [emptyRow()],
    );
    setHydrated(true);
  }, [sale, hydrated]);

  useEffect(() => {
    if (!payAccountId && accounts[0]) setPayAccountId(accounts[0].id);
  }, [accounts, payAccountId]);

  const totalKopecks = useMemo(
    () =>
      items.reduce((sum, r) => {
        const qty = Math.floor(Number(r.qtyStr)) || 0;
        const price = Math.round((Number(r.priceRubStr.replace(',', '.')) || 0) * 100);
        return sum + qty * price;
      }, 0),
    [items],
  );
  const costKopecks = useMemo(
    () =>
      items.reduce((sum, r) => {
        const qty = Math.floor(Number(r.qtyStr)) || 0;
        const cost = Math.round((Number(r.costRubStr.replace(',', '.')) || 0) * 100);
        return sum + qty * cost;
      }, 0),
    [items],
  );

  const create = trpc.sales.create.useMutation({
    onSuccess: (res) => {
      void utils.sales.list.invalidate();
      navigate(`/sales/${res.id}`);
    },
    onError: (e) => setErr(e.message),
  });
  const update = trpc.sales.update.useMutation({
    onSuccess: () => {
      void utils.sales.list.invalidate();
      if (editId) void utils.sales.get.invalidate({ id: editId });
      navigate('/sales');
    },
    onError: (e) => setErr(e.message),
  });
  const refresh = () => {
    if (editId) void utils.sales.get.invalidate({ id: editId });
    void utils.sales.list.invalidate();
    void utils.cash.invalidate();
  };
  const setStatusM = trpc.sales.setStatus.useMutation({ onSuccess: refresh });
  const payM = trpc.sales.pay.useMutation({ onSuccess: refresh, onError: (e) => setErr(e.message) });
  const unpayM = trpc.sales.unpay.useMutation({ onSuccess: refresh });
  const deleteM = trpc.sales.delete.useMutation({
    onSuccess: () => {
      void utils.sales.list.invalidate();
      navigate('/sales');
    },
  });

  const saving = create.isPending || update.isPending;

  const buildItems = () =>
    items
      .map((r) => ({
        name: r.name.trim(),
        quantity: Math.max(1, Math.floor(Number(r.qtyStr)) || 1),
        priceRub: Number(r.priceRubStr.replace(',', '.')) || 0,
        costRub: Number(r.costRubStr.replace(',', '.')) || 0,
      }))
      .filter((r) => r.name.length > 0);

  const submit = () => {
    setErr(null);
    if (!clientId) {
      setErr('Укажите клиента');
      return;
    }
    const built = buildItems();
    if (built.length === 0) {
      setErr('Добавьте хотя бы одну позицию с названием');
      return;
    }
    if (isEdit && editId) {
      update.mutate({ id: editId, supplier: supplier.trim() || null, comment: comment.trim() || null, items: built });
    } else {
      create.mutate({ clientId, supplier: supplier.trim() || null, comment: comment.trim() || null, items: built });
    }
  };

  if (isEdit && existing.isLoading) {
    return (
      <div className="text-muted-foreground mx-auto max-w-3xl p-6 text-sm">Загружаем…</div>
    );
  }

  // Пока записи НЕТ — форму не показываем. Условие именно «нет данных», а не «есть
  // ошибка»: при потере связи react-query не роняет запрос, а ставит его на паузу,
  // и error остаётся пустым НАВСЕГДА (проверено в браузере: fetchStatus 'paused').
  // Форма в этот момент показывала бы пустые поля с рабочей кнопкой «Сохранить», и
  // патч ушёл бы со ВСЕМИ полями, затерев то, что лежит в базе.
  if (isEdit && !existing.data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
        <Link
          href="/sales"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" /> К списку продаж
        </Link>
        <QueryError
          error={existing.error}
          paused={existing.fetchStatus === 'paused'}
          what="продажу"
          onRetry={() => void existing.refetch()}
        />
        {/* Пока данные ещё едут — ошибки нет, и QueryError молчит. Без этой строки
            человек видел бы пустую страницу без единого слова. */}
        {!existing.error && existing.fetchStatus !== 'paused' && (
          <div className="text-muted-foreground text-sm">Загрузка…</div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <Link href="/sales" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
        <ChevronLeft className="h-4 w-4" />
        К списку продаж
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold md:text-2xl">
          {isEdit ? `Продажа №${sale?.saleNo ?? ''}` : 'Новая продажа'}
        </h1>
        {isEdit && sale && (
          <StatusBadge variant={SALE_STATUS_META[sale.status].variant}>
            {SALE_STATUS_META[sale.status].label}
          </StatusBadge>
        )}
      </div>

      {isPaid && (
        <div className="bg-success/10 text-success border-success/30 rounded-md border p-3 text-sm">
          Продажа оплачена. Чтобы изменить позиции — сначала отмените оплату ниже.
        </div>
      )}

      {/* Основная форма */}
      <section className="bg-card space-y-4 rounded-lg border p-4 md:p-5">
        <div>
          <label className="mb-1 block text-sm font-medium">Клиент</label>
          {isEdit ? (
            <div className="bg-muted/50 rounded-md border px-3 py-2 text-sm font-medium">
              {clientName || '—'}
            </div>
          ) : (
            <ClientPicker
              value={clientId}
              onChange={(id, name) => {
                setClientId(id || null);
                setClientName(name);
              }}
            />
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Поставщик (опц.)</label>
          <input type="text" value={supplier} onChange={(e) => setSupplier(e.target.value)} disabled={isPaid} placeholder="У кого закупаем" className={inputCls} />
        </div>

        {/* Позиции */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium">Позиции</label>
            {!isPaid && (
              <button type="button" onClick={() => setItems((p) => [...p, emptyRow()])} className="text-primary inline-flex items-center gap-1 text-sm hover:underline">
                <Plus className="h-3.5 w-3.5" />
                Добавить
              </button>
            )}
          </div>
          <div className="text-muted-foreground mb-1 hidden grid-cols-[1fr_52px_92px_92px_32px] gap-2 px-1 text-[11px] sm:grid">
            <span>Наименование</span>
            <span className="text-right">Кол-во</span>
            <span className="text-right">Цена ₽</span>
            <span className="text-right">Закупка ₽</span>
            <span />
          </div>
          <div className="space-y-2">
            {items.map((row, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_52px_92px_92px_32px] gap-2">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) => setItems((p) => p.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r)))}
                  disabled={isPaid}
                  placeholder="Наименование (модель, арт.)"
                  className={inputCls}
                />
                <input
                  type="number"
                  min={1}
                  value={row.qtyStr}
                  onChange={(e) => setItems((p) => p.map((r, i) => (i === idx ? { ...r, qtyStr: e.target.value } : r)))}
                  disabled={isPaid}
                  placeholder="Кол-во"
                  className={`${inputCls} text-right`}
                />
                <input
                  type="text"
                  inputMode="decimal"
                  value={row.priceRubStr}
                  onChange={(e) => setItems((p) => p.map((r, i) => (i === idx ? { ...r, priceRubStr: e.target.value } : r)))}
                  disabled={isPaid}
                  placeholder="Цена, ₽"
                  className={`${inputCls} text-right`}
                />
                <input
                  type="text"
                  inputMode="decimal"
                  value={row.costRubStr}
                  onChange={(e) => setItems((p) => p.map((r, i) => (i === idx ? { ...r, costRubStr: e.target.value } : r)))}
                  disabled={isPaid}
                  placeholder="Закупка"
                  title="За сколько купили (за единицу) — для маржи"
                  className={`${inputCls} text-right`}
                />
                <button
                  type="button"
                  disabled={isPaid || items.length === 1}
                  onClick={() => setItems((p) => p.filter((_, i) => i !== idx))}
                  className="text-muted-foreground hover:text-destructive grid place-items-center rounded disabled:opacity-30"
                  title="Удалить позицию"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-1 border-t pt-3 text-right text-sm">
            <div>
              <span className="text-muted-foreground">Сумма продажи: </span>
              <span className="text-lg font-semibold tabular-nums">{formatRub(String(totalKopecks))}</span>
            </div>
            {costKopecks > 0 && (
              <>
                <div className="text-muted-foreground">
                  Закупка: <span className="tabular-nums">{formatRub(String(costKopecks))}</span>
                </div>
                <div className="text-muted-foreground">
                  Маржа:{' '}
                  <span
                    className={
                      totalKopecks - costKopecks >= 0
                        ? 'text-success font-medium tabular-nums'
                        : 'text-destructive font-medium tabular-nums'
                    }
                  >
                    {formatRub(String(totalKopecks - costKopecks))}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Комментарий</label>
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} disabled={isPaid} className={inputCls} />
        </div>

        {err && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2 text-xs">{err}</div>
        )}

        {!isPaid && (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => navigate('/sales')} className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium">
              Отмена
            </button>
            <button type="button" onClick={submit} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {isEdit ? 'Сохранить' : 'Создать продажу'}
            </button>
          </div>
        )}
      </section>

      {/* Статус + оплата + удаление — только для существующей продажи */}
      {isEdit && sale && (
        <>
          <section className="bg-card flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
            <div>
              <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Статус заказа</div>
              <select
                value={sale.status}
                onChange={(e) => setStatusM.mutate({ id: sale.id, status: e.target.value as SaleStatus })}
                disabled={setStatusM.isPending}
                className="border-input bg-background focus:ring-primary/40 mt-1 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2"
              >
                {(Object.keys(SALE_STATUS_META) as SaleStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {SALE_STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </div>
            {sale.marginKopecks && (
              <div className="text-right">
                <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Маржа</div>
                <div className="mt-1 text-base font-semibold tabular-nums">{formatRub(sale.marginKopecks)}</div>
              </div>
            )}
          </section>

          <section className="bg-card rounded-lg border p-4">
            <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">Оплата клиентом</div>
            {isPaid ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-success inline-flex items-center gap-2 text-sm font-medium">
                  <Check className="h-4 w-4" />
                  Оплачено {sale.paidOn ? new Date(sale.paidOn).toLocaleDateString('ru-RU') : ''} · {formatRub(sale.totalKopecks)}
                </div>
                <button
                  type="button"
                  onClick={() => unpayM.mutate({ id: sale.id })}
                  disabled={unpayM.isPending}
                  className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                >
                  Отменить оплату
                </button>
              </div>
            ) : accounts.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Заведите денежный счёт в{' '}
                <Link href="/finance/accounts" className="text-primary hover:underline">кассе</Link>, чтобы принять оплату.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="text-muted-foreground mb-1 block text-xs">На счёт</label>
                  <select value={payAccountId} onChange={(e) => setPayAccountId(e.target.value)} className="border-input bg-background focus:ring-primary/40 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2">
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-muted-foreground mb-1 block text-xs">Дата</label>
                  <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className="border-input bg-background focus:ring-primary/40 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2" />
                </div>
                <button
                  type="button"
                  onClick={() => payM.mutate({ id: sale.id, accountId: payAccountId, paidOn: payDate })}
                  disabled={payM.isPending || totalKopecks <= 0}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
                >
                  <Wallet className="h-4 w-4" />
                  Принять оплату {formatRub(sale.totalKopecks)}
                </button>
              </div>
            )}
          </section>

          <div className="flex justify-end">
            <button type="button" onClick={() => setToDelete(true)} className="text-destructive hover:bg-destructive/10 rounded-md px-3 py-1.5 text-sm font-medium">
              Удалить продажу
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={toDelete}
        title="Удалить продажу?"
        description="Запись будет удалена. Если по ней была проведена оплата — связанный доход уберётся из кассы."
        confirmText="Удалить"
        variant="danger"
        loading={deleteM.isPending}
        onConfirm={() => editId && deleteM.mutate({ id: editId })}
        onCancel={() => setToDelete(false)}
      />
    </div>
  );
}
