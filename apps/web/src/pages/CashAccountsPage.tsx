/**
 * /finance/accounts — управление денежными счетами и статьями (директор).
 * Счета: создание/правка (имя, тип, метод по умолчанию, стартовый остаток, архив), удаление.
 * Статьи: добавление/архивация по направлениям (доход/расход).
 */
import { useEffect, useState } from 'react';
import { Archive, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { formatRub } from '../lib/money';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { FinanceTabs } from '../components/finance/FinanceTabs';
import { CASH_ACCOUNT_KIND_LABEL, PAYMENT_METHOD_LABEL } from '../lib/dictionaries';

type Kind = 'cash' | 'bank' | 'card';
type Method = 'cash' | 'card' | 'bank_transfer';

interface Account {
  id: string;
  name: string;
  kind: Kind;
  openingBalanceKopecks: string;
  balanceKopecks: string;
  defaultForMethod: Method | null;
  isArchived: boolean;
}

export function CashAccountsPage() {
  const [modal, setModal] = useState<{ open: boolean; edit?: Account }>({ open: false });
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const accountsQ = trpc.cash.accounts.list.useQuery({ includeArchived: true });
  const del = trpc.cash.accounts.delete.useMutation({
    onSuccess: async () => {
      setDeleteId(null);
      await Promise.all([utils.cash.accounts.list.invalidate(), utils.cash.overview.invalidate()]);
    },
  });

  const accounts = (accountsQ.data ?? []) as Account[];

  return (
    // Внешний контейнер той же ширины, что у остальных вкладок «Финансов», —
    // иначе вкладки «прыгают» при переходе. Контент держим узким по центру.
    <div className="mx-auto max-w-[1600px] p-4 md:p-6">
      <FinanceTabs />

      <div className="mx-auto mt-4 max-w-5xl space-y-6 md:mt-6">
        {/* Счета */}
        <section className="bg-card rounded-xl border shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="text-base font-semibold">Денежные счета</h2>
            <button
              type="button"
              onClick={() => setModal({ open: true })}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
            >
              <Plus className="h-4 w-4" /> Счёт
            </button>
          </div>
          {accountsQ.isLoading ? (
            <div className="text-muted-foreground p-6 text-sm">Загружаем…</div>
          ) : accounts.length === 0 ? (
            <div className="text-muted-foreground p-6 text-sm">Счетов пока нет.</div>
          ) : (
            <div className="divide-y">
              {accounts.map((a) => (
                <div
                  key={a.id}
                  className={cn(
                    'flex items-center justify-between gap-3 p-4',
                    a.isArchived && 'opacity-60',
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{a.name}</span>
                      {a.isArchived && (
                        <span className="bg-secondary text-muted-foreground rounded px-1.5 py-0.5 text-[11px]">
                          в архиве
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {CASH_ACCOUNT_KIND_LABEL[a.kind]}
                      {a.defaultForMethod &&
                        ` · по умолчанию для: ${PAYMENT_METHOD_LABEL[a.defaultForMethod]}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        BigInt(a.balanceKopecks) < 0n && 'text-destructive',
                      )}
                    >
                      {formatRub(a.balanceKopecks)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setModal({ open: true, edit: a })}
                      className="text-muted-foreground hover:bg-muted hover:text-foreground grid h-7 w-7 place-items-center rounded transition"
                      aria-label="Редактировать счёт"
                      title="Редактировать"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteId(a.id)}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive grid h-7 w-7 place-items-center rounded transition"
                      aria-label="Удалить счёт"
                      title="Удалить (или архивировать, если есть операции)"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Статьи */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <CategorySection direction="income" title="Статьи доходов" />
          <CategorySection direction="expense" title="Статьи расходов" />
        </div>

        <AccountModal
          open={modal.open}
          edit={modal.edit}
          onClose={() => setModal({ open: false })}
        />

        <ConfirmDialog
          open={deleteId !== null}
          title="Удалить счёт?"
          description="Если по счёту есть операции, он будет перемещён в архив (данные сохранятся). Иначе — удалён."
          confirmText="Удалить"
          variant="danger"
          loading={del.isPending}
          onConfirm={() => deleteId && del.mutate({ id: deleteId })}
          onCancel={() => setDeleteId(null)}
        />
      </div>
    </div>
  );
}

/* ───────────────────────────── статьи ───────────────────────────── */

function CategorySection({ direction, title }: { direction: 'income' | 'expense'; title: string }) {
  const [newName, setNewName] = useState('');
  const utils = trpc.useUtils();
  const q = trpc.cash.categories.list.useQuery({ direction, includeArchived: true });

  const invalidate = () =>
    Promise.all([utils.cash.categories.list.invalidate(), utils.cash.overview.invalidate()]);

  const create = trpc.cash.categories.create.useMutation({
    onSuccess: async () => {
      setNewName('');
      await invalidate();
    },
  });
  const update = trpc.cash.categories.update.useMutation({ onSuccess: () => invalidate() });

  const cats = q.data ?? [];

  return (
    <section className="bg-card rounded-xl border shadow-sm">
      <div className="border-b p-4">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <div className="divide-y">
        {cats.length === 0 && (
          <div className="text-muted-foreground p-4 text-sm">Статей пока нет.</div>
        )}
        {cats.map((c) => (
          <div
            key={c.id}
            className={cn(
              'flex items-center justify-between gap-2 px-4 py-2.5',
              c.isArchived && 'opacity-50',
            )}
          >
            <span className="text-sm">{c.name}</span>
            <button
              type="button"
              onClick={() => update.mutate({ id: c.id, isArchived: !c.isArchived })}
              className="text-muted-foreground hover:text-foreground text-xs"
              title={c.isArchived ? 'Вернуть из архива' : 'В архив'}
              aria-label={c.isArchived ? 'Вернуть из архива' : 'В архив'}
            >
              {c.isArchived ? 'Вернуть' : <Archive className="h-3.5 w-3.5" />}
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t p-3">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim())
              create.mutate({ name: newName.trim(), direction });
          }}
          placeholder="Новая статья"
          className="bg-background focus:ring-primary/40 flex-1 rounded-md border px-3 py-1.5 text-sm outline-none focus:ring-2"
        />
        <button
          type="button"
          onClick={() => newName.trim() && create.mutate({ name: newName.trim(), direction })}
          disabled={!newName.trim() || create.isPending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 grid h-8 w-8 place-items-center rounded-md transition disabled:opacity-50"
          aria-label="Добавить статью"
        >
          {create.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
        </button>
      </div>
    </section>
  );
}

/* ───────────────────────────── модалка счёта ───────────────────────────── */

function AccountModal({
  open,
  edit,
  onClose,
}: {
  open: boolean;
  edit?: Account;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('cash');
  const [defaultForMethod, setDefaultForMethod] = useState<'' | Method>('');
  const [openingRub, setOpeningRub] = useState('');
  const [isArchived, setIsArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(edit?.name ?? '');
      setKind(edit?.kind ?? 'cash');
      setDefaultForMethod(edit?.defaultForMethod ?? '');
      setOpeningRub(edit ? String(Number(edit.openingBalanceKopecks) / 100) : '');
      setIsArchived(edit?.isArchived ?? false);
      setError(null);
    }
  }, [open, edit]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const invalidate = () =>
    Promise.all([utils.cash.accounts.list.invalidate(), utils.cash.overview.invalidate()]);

  const create = trpc.cash.accounts.create.useMutation({
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  const update = trpc.cash.accounts.update.useMutation({
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  if (!open) return null;

  const opening = openingRub.trim() ? Number(openingRub.replace(',', '.')) : 0;
  const canSave = name.trim().length > 0 && Number.isFinite(opening);

  const submit = () => {
    setError(null);
    if (!canSave) {
      setError('Укажите название счёта.');
      return;
    }
    const payload = {
      name: name.trim(),
      kind,
      defaultForMethod: defaultForMethod || null,
      openingBalanceRub: opening,
    };
    if (edit) {
      update.mutate({ id: edit.id, ...payload, isArchived });
    } else {
      create.mutate(payload);
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-card w-full max-w-md rounded-xl border shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={edit ? 'Редактировать счёт' : 'Новый счёт'}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">{edit ? 'Редактировать счёт' : 'Новый счёт'}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:bg-muted hover:text-foreground grid h-7 w-7 place-items-center rounded transition"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <label className="block">
            <span className="text-xs font-medium">Название</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Наличные, Расчётный счёт…"
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium">Тип</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as Kind)}
                className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              >
                <option value="cash">Наличные</option>
                <option value="bank">Расчётный счёт</option>
                <option value="card">Карта</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium">Стартовый остаток, ₽</span>
              <input
                type="text"
                inputMode="decimal"
                value={openingRub}
                onChange={(e) => setOpeningRub(e.target.value)}
                placeholder="0"
                className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium">Зачислять сюда оплаты по заявкам</span>
            <select
              value={defaultForMethod}
              onChange={(e) => setDefaultForMethod(e.target.value as '' | Method)}
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            >
              <option value="">Не использовать по умолчанию</option>
              <option value="cash">Наличными</option>
              <option value="card">Картой</option>
              <option value="bank_transfer">Переводом (банк)</option>
            </select>
          </label>

          {edit && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isArchived}
                onChange={(e) => setIsArchived(e.target.checked)}
              />
              В архиве (скрыт из выбора при операциях)
            </label>
          )}

          {error && <div className="text-destructive text-sm">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="hover:bg-muted rounded-md border px-4 py-2 text-sm font-medium"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSave || busy}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
