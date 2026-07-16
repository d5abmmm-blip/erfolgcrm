/**
 * Модалка внутренней операции кассы: «Внесение в кассу» / «Выдача из кассы».
 * Это НЕ доход/расход бизнеса (обнал и т.п.): остаток счёта меняется, но в сводках
 * кассы такие операции по умолчанию не учитываются (тумблер на обзоре включает их
 * для сверки с реальным сейфом). Сумма в рублях — сервер хранит копейки.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, X } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { cn } from '../../lib/utils';
import { parsePositiveRub } from '../../lib/cash-format';

type Kind = 'deposit' | 'withdrawal';

interface Props {
  open: boolean;
  onClose: () => void;
  initialKind?: Kind;
  onSaved?: () => void;
}

const today = () => new Date().toISOString().slice(0, 10);

export function CashInternalOpModal({ open, onClose, initialKind = 'deposit', onSaved }: Props) {
  const utils = trpc.useUtils();
  const rootRef = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<Kind>(initialKind);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [occurredOn, setOccurredOn] = useState(today());
  const [counterparty, setCounterparty] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const accountsQ = trpc.cash.accounts.list.useQuery(undefined, { enabled: open });
  const accounts = useMemo(() => accountsQ.data ?? [], [accountsQ.data]);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setAmount('');
      setOccurredOn(today());
      setCounterparty('');
      setComment('');
      setError(null);
    }
  }, [open, initialKind]);

  // Дефолт — первый наличный счёт (внесения/выдачи почти всегда про сейф).
  useEffect(() => {
    if (open && accounts.length > 0 && !accountId) {
      const cashAcc = accounts.find((a) => a.kind === 'cash');
      setAccountId((cashAcc ?? accounts[0]!).id);
    }
  }, [open, accounts, accountId]);

  // Esc — закрыть; фокус на первое поле (паттерн CashTransactionModal).
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('input, select')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const create = trpc.cash.internalAdd.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.cash.overview.invalidate(),
        utils.cash.transactions.list.invalidate(),
        utils.cash.accounts.list.invalidate(),
        utils.cash.categories.list.invalidate(),
      ]);
      onSaved?.();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  if (!open) return null;

  const parsedAmount = parsePositiveRub(amount);
  const canSave = parsedAmount !== null && accountId.length > 0;

  const submit = () => {
    setError(null);
    if (!canSave || parsedAmount === null) {
      setError('Заполните сумму и счёт.');
      return;
    }
    create.mutate({
      kind,
      accountId,
      amountRub: parsedAmount,
      occurredOn,
      counterparty: counterparty.trim() || null,
      comment: comment.trim() || null,
    });
  };

  const inputCls =
    'bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2';

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
        aria-label="Внесение или выдача"
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">Внесение / выдача</h2>
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
          <div className="bg-secondary grid grid-cols-2 gap-1 rounded-md p-1">
            <button
              type="button"
              onClick={() => setKind('deposit')}
              className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium transition',
                kind === 'deposit'
                  ? 'bg-success text-success-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <ArrowDownToLine className="h-4 w-4" />
              Внесение в кассу
            </button>
            <button
              type="button"
              onClick={() => setKind('withdrawal')}
              className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium transition',
                kind === 'withdrawal'
                  ? 'bg-destructive text-destructive-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <ArrowUpFromLine className="h-4 w-4" />
              Выдача из кассы
            </button>
          </div>

          <p className="text-muted-foreground text-xs">
            Внутренняя операция (обнал, деньги владельцев и т.п.): остаток счёта изменится, но{' '}
            <b>доходом или расходом бизнеса это не считается</b> — в сводках «Финансов» такие
            операции видны только при включённом тумблере «Учитывать внесения/выдачи».
          </p>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium">Сумма, ₽</span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium">Дата</span>
              <input
                type="date"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
                className={inputCls}
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium">Счёт</span>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className={inputCls}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium">
              {kind === 'deposit' ? 'От кого (необязательно)' : 'Кому (необязательно)'}
            </span>
            <input
              type="text"
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder="Расул, Тимур…"
              className={inputCls}
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium">Комментарий (необязательно)</span>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className={inputCls}
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
