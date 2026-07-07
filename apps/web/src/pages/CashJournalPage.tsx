/**
 * /finance/transactions — журнал прихода и расхода кассы (движение денег).
 * Фильтры (тип / счёт / статья / период), кнопки +Доход/+Расход/Перевод (модалка),
 * удаление операции. RBAC: staff. Авто-доходы от оплат помечены «из заявки».
 */
import { useState } from 'react';
import { ArrowRightLeft, Trash2, TrendingDown, TrendingUp } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub } from '../lib/money';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { FinanceTabs } from '../components/finance/FinanceTabs';
import { CashTransactionModal } from '../components/finance/CashTransactionModal';
import { CASH_TX_KIND_META } from '../lib/dictionaries';
import { cn } from '../lib/utils';

type Kind = 'income' | 'expense' | 'transfer';
const PAGE_SIZE = 50;

const KIND_BADGE: Record<Kind, StatusBadgeVariant> = {
  income: 'success',
  expense: 'danger',
  transfer: 'info',
};

interface Row {
  id: string;
  kind: Kind;
  accountName: string | null;
  counterAccountName: string | null;
  categoryName: string | null;
  amountKopecks: string;
  occurredOn: string;
  comment: string | null;
  counterparty: string | null;
  clientName: string | null;
  source: 'manual' | 'payment';
}

export function CashJournalPage() {
  const [kind, setKind] = useState<'' | Kind>('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [modalKind, setModalKind] = useState<Kind | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const accountsQ = trpc.cash.accounts.list.useQuery({ includeArchived: true });
  const categoriesQ = trpc.cash.categories.list.useQuery({ includeArchived: true });

  const listQ = trpc.cash.transactions.list.useQuery({
    kind: kind || undefined,
    accountId: accountId || undefined,
    categoryId: categoryId || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    limit: PAGE_SIZE,
  });

  const del = trpc.cash.transactions.delete.useMutation({
    onSuccess: async () => {
      setDeleteId(null);
      await Promise.all([
        utils.cash.transactions.list.invalidate(),
        utils.cash.overview.invalidate(),
        utils.cash.accounts.list.invalidate(),
      ]);
    },
  });

  const items = (listQ.data?.items ?? []) as Row[];
  const total = listQ.data?.total ?? 0;

  const columns: Column<Row>[] = [
    {
      key: 'occurredOn',
      label: 'Дата',
      className: 'text-xs whitespace-nowrap',
      render: (r) => new Date(r.occurredOn).toLocaleDateString('ru-RU'),
    },
    {
      key: 'kind',
      label: 'Тип',
      render: (r) => <StatusBadge variant={KIND_BADGE[r.kind]}>{CASH_TX_KIND_META[r.kind].label}</StatusBadge>,
    },
    {
      key: 'description',
      label: 'Назначение',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate">
            {r.comment || (r.kind === 'transfer' ? 'Перевод между счетами' : r.categoryName || 'Без статьи')}
          </div>
          <div className="text-muted-foreground truncate text-xs">
            {r.kind === 'transfer'
              ? `${r.accountName ?? '—'} → ${r.counterAccountName ?? '—'}`
              : [r.categoryName, r.counterparty || r.clientName].filter(Boolean).join(' · ') || '—'}
            {r.source === 'payment' && ' · из заявки'}
          </div>
        </div>
      ),
    },
    {
      key: 'account',
      label: 'Счёт',
      className: 'text-xs whitespace-nowrap',
      render: (r) => r.accountName ?? '—',
    },
    {
      key: 'amount',
      label: 'Сумма',
      className: 'text-right tabular-nums whitespace-nowrap',
      headerClassName: 'text-right',
      render: (r) => {
        const meta = CASH_TX_KIND_META[r.kind];
        return (
          <span className={cn('font-medium', meta.cls)}>
            {meta.sign}
            {formatRub(r.amountKopecks)}
          </span>
        );
      },
    },
    {
      key: 'actions',
      label: '',
      className: 'text-right',
      render: (r) => (
        <button
          type="button"
          onClick={() => setDeleteId(r.id)}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive grid h-7 w-7 place-items-center rounded transition"
          aria-label="Удалить операцию"
          title="Удалить"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ),
    },
  ];

  const resetPageAnd = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <FinanceTabs />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">Приход и расход</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setModalKind('income')}
            className="bg-success/12 text-success hover:bg-success/20 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
          >
            <TrendingUp className="h-4 w-4" /> Доход
          </button>
          <button
            type="button"
            onClick={() => setModalKind('expense')}
            className="bg-destructive/12 text-destructive hover:bg-destructive/20 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
          >
            <TrendingDown className="h-4 w-4" /> Расход
          </button>
          <button
            type="button"
            onClick={() => setModalKind('transfer')}
            className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition"
          >
            <ArrowRightLeft className="h-4 w-4" /> Перевод
          </button>
        </div>
      </div>

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={kind}
          onChange={(e) => resetPageAnd(() => setKind(e.target.value as '' | Kind))}
          className="bg-background rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="">Все типы</option>
          <option value="income">Доходы</option>
          <option value="expense">Расходы</option>
          <option value="transfer">Переводы</option>
        </select>
        <select
          value={accountId}
          onChange={(e) => resetPageAnd(() => setAccountId(e.target.value))}
          className="bg-background rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="">Все счета</option>
          {(accountsQ.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={categoryId}
          onChange={(e) => resetPageAnd(() => setCategoryId(e.target.value))}
          className="bg-background rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="">Все статьи</option>
          {(categoriesQ.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => resetPageAnd(() => setFrom(e.target.value))}
          className="bg-background rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          aria-label="С даты"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => resetPageAnd(() => setTo(e.target.value))}
          className="bg-background rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          aria-label="По дату"
        />
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={listQ.isLoading}
        error={listQ.error ? { message: listQ.error.message } : null}
        emptyText="Операций не найдено"
        rowKey={(r) => r.id}
      />

      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <CashTransactionModal
        open={modalKind !== null}
        initialKind={modalKind ?? 'expense'}
        onClose={() => setModalKind(null)}
      />

      <ConfirmDialog
        open={deleteId !== null}
        title="Удалить операцию?"
        description="Операция будет удалена, остаток счёта пересчитается."
        confirmText="Удалить"
        variant="danger"
        loading={del.isPending}
        error={del.error?.message ?? null}
        onConfirm={() => deleteId && del.mutate({ id: deleteId })}
        onCancel={() => {
          setDeleteId(null);
          del.reset();
        }}
      />
    </div>
  );
}
