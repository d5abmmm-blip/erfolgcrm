/**
 * /invoices — список всех счетов tenant'а с фильтром по статусу.
 * RBAC: чтение (invoices.listForTenant) — staff (директор+диспетчер); создание — через карточку заявки.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { FileText, Search } from 'lucide-react';
import type { InvoiceStatus } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { useDebounce } from '../lib/hooks/useDebounce';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { INVOICE_STATUS_META } from '../lib/dictionaries';
import { formatRub } from '../lib/money';
import { FinanceTabs } from '../components/finance/FinanceTabs';

const STATUS_OPTIONS: Array<{ value: InvoiceStatus | ''; label: string }> = [
  { value: '', label: 'Все' },
  { value: 'draft', label: 'Черновик' },
  { value: 'issued', label: 'Выставлен' },
  { value: 'partially_paid', label: 'Частично оплачен' },
  { value: 'paid', label: 'Оплачен' },
  { value: 'overdue', label: 'Просрочен' },
  { value: 'cancelled', label: 'Отменён' },
];

type StatusOption = InvoiceStatus | '';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  totalAmountKopecks: string;
  paidAmountKopecks: string;
  dueDate: string | null | undefined;
  ticketId: string;
}

const PAGE_SIZE = 50;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

export function InvoicesPage() {
  const [status, setStatus] = useState<StatusOption>('');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim().toLowerCase(), 300);
  const [page, setPage] = useState(1);

  const list = trpc.invoices.listForTenant.useQuery({
    status: status || undefined,
    limit: PAGE_SIZE,
    page,
  });

  const items = (list.data?.items ?? []) as InvoiceRow[];
  const total = list.data?.total ?? 0;

  // Client-side search by invoice number (lightweight — server doesn't have full-text search).
  const filtered = debounced
    ? items.filter((inv) => inv.invoiceNumber.toLowerCase().includes(debounced))
    : items;

  const columns: Column<InvoiceRow>[] = [
    {
      key: 'invoiceNumber',
      label: 'Номер',
      className: 'font-mono text-xs',
      render: (inv) => (
        <Link
          href={`/invoices/${inv.id}`}
          className="text-foreground hover:text-primary font-medium"
        >
          {inv.invoiceNumber}
        </Link>
      ),
    },
    {
      key: 'status',
      label: 'Статус',
      render: (inv) => {
        const meta = INVOICE_STATUS_META[inv.status];
        return <StatusBadge variant={meta.variant}>{meta.shortLabel ?? meta.label}</StatusBadge>;
      },
    },
    {
      key: 'totalAmountKopecks',
      label: 'Сумма',
      className: 'text-right tabular-nums',
      headerClassName: 'text-right',
      render: (inv) => formatRub(inv.totalAmountKopecks),
    },
    {
      key: 'paidAmountKopecks',
      label: 'Оплачено',
      className: 'text-right tabular-nums text-xs',
      headerClassName: 'text-right',
      render: (inv) => formatRub(inv.paidAmountKopecks),
    },
    {
      key: 'dueDate',
      label: 'Срок оплаты',
      className: 'text-xs',
      render: (inv) => formatDate(inv.dueDate),
    },
    {
      key: 'ticket',
      label: 'Заявка',
      className: 'text-xs',
      render: (inv) => (
        <Link
          href={`/tickets/${inv.ticketId}`}
          className="text-muted-foreground hover:text-primary"
        >
          заявка
        </Link>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <FinanceTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <FileText className="h-3.5 w-3.5" />
            Финансы
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Счета на оплату</h1>
          <p className="text-muted-foreground text-sm">
            Все счета компании. Создание — из карточки заявки.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по номеру счёта"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StatusOption);
            setPage(1);
          }}
          className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        data={filtered}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Счетов не найдено"
        rowKey={(inv) => inv.id}
      />

      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}
