/**
 * Модалка добавления операции кассы: Доход / Расход / Перевод между счетами.
 * Тип переключается вкладками вверху. Сумма вводится в рублях (сервер хранит копейки).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, Loader2, TrendingDown, TrendingUp, X } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { cn } from '../../lib/utils';
import { parsePositiveRub } from '../../lib/cash-format';

type Kind = 'income' | 'expense' | 'transfer';

interface Props {
  open: boolean;
  onClose: () => void;
  initialKind?: Kind;
  onSaved?: () => void;
}

const today = () => new Date().toISOString().slice(0, 10);

export function CashTransactionModal({ open, onClose, initialKind = 'expense', onSaved }: Props) {
  const utils = trpc.useUtils();
  const rootRef = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<Kind>(initialKind);
  const [accountId, setAccountId] = useState('');
  const [counterAccountId, setCounterAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [occurredOn, setOccurredOn] = useState(today());
  const [comment, setComment] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [error, setError] = useState<string | null>(null);

  const accountsQ = trpc.cash.accounts.list.useQuery(undefined, { enabled: open });
  const categoriesQ = trpc.cash.categories.list.useQuery(
    { direction: kind === 'income' ? 'income' : 'expense' },
    { enabled: open && kind !== 'transfer' },
  );

  const accounts = useMemo(() => accountsQ.data ?? [], [accountsQ.data]);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setAccountId('');
      setCounterAccountId('');
      setCategoryId('');
      setAmount('');
      setOccurredOn(today());
      setComment('');
      setCounterparty('');
      setError(null);
    }
  }, [open, initialKind]);

  // Esc — закрыть; Tab — фокус-ловушка внутри модалки (WAI-ARIA), фокус на первое поле.
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('input, textarea, select')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && rootRef.current) {
        const focusables = rootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !rootRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !rootRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const create = trpc.cash.transactions.create.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.cash.overview.invalidate(),
        utils.cash.transactions.list.invalidate(),
        utils.cash.accounts.list.invalidate(),
      ]);
      onSaved?.();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  if (!open) return null;

  const parsedAmount = parsePositiveRub(amount);
  const canSave =
    parsedAmount !== null &&
    accountId.length > 0 &&
    (kind === 'transfer' ? counterAccountId.length > 0 && counterAccountId !== accountId : true);

  const submit = () => {
    setError(null);
    if (!canSave || parsedAmount === null) {
      setError('Заполните сумму и счёт.');
      return;
    }
    create.mutate({
      kind,
      accountId,
      counterAccountId: kind === 'transfer' ? counterAccountId : null,
      categoryId: kind === 'transfer' ? null : categoryId || null,
      amountRub: parsedAmount,
      occurredOn,
      comment: comment.trim() || null,
      counterparty: kind === 'transfer' ? null : counterparty.trim() || null,
    });
  };

  const TABS: Array<{ k: Kind; label: string; icon: typeof TrendingUp; activeCls: string }> = [
    {
      k: 'income',
      label: 'Доход',
      icon: TrendingUp,
      activeCls: 'bg-success text-success-foreground',
    },
    {
      k: 'expense',
      label: 'Расход',
      icon: TrendingDown,
      activeCls: 'bg-destructive text-destructive-foreground',
    },
    {
      k: 'transfer',
      label: 'Перевод',
      icon: ArrowRightLeft,
      activeCls: 'bg-primary text-primary-foreground',
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={rootRef}
        className="bg-card max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Новая операция"
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">Новая операция</h2>
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
          {/* Тип операции */}
          <div className="bg-secondary grid grid-cols-3 gap-1 rounded-md p-1">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.k}
                  type="button"
                  onClick={() => setKind(t.k)}
                  className={cn(
                    'inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium transition',
                    kind === t.k ? t.activeCls : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium">Сумма, ₽</span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium">Дата</span>
              <input
                type="date"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
                className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium">{kind === 'transfer' ? 'Со счёта' : 'Счёт'}</span>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            >
              <option value="">— выберите счёт —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          {kind === 'transfer' ? (
            <label className="block">
              <span className="text-xs font-medium">На счёт</span>
              <select
                value={counterAccountId}
                onChange={(e) => setCounterAccountId(e.target.value)}
                className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              >
                <option value="">— выберите счёт —</option>
                {accounts
                  .filter((a) => a.id !== accountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <>
              <label className="block">
                <span className="text-xs font-medium">Статья</span>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                >
                  <option value="">— без статьи —</option>
                  {(categoriesQ.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium">Контрагент (необязательно)</span>
                <input
                  type="text"
                  value={counterparty}
                  onChange={(e) => setCounterparty(e.target.value)}
                  placeholder="Поставщик, арендодатель…"
                  className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                />
              </label>
            </>
          )}

          <label className="block">
            <span className="text-xs font-medium">Комментарий (необязательно)</span>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </label>

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
            disabled={!canSave || create.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50"
          >
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
