/**
 * Список контрактов с фильтрами по статусу/клиенту/поиску.
 * RBAC: чтение — engineer+; create-кнопка — staff (диспетчер/директор), но фильтрация на сервере.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { FileSignature, Plus, Search } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { useDebounce } from '../lib/hooks/useDebounce';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';

type ContractStatus = 'active' | 'draft' | 'expired' | 'terminated';
type ContractType = 'service' | 'one_time';

const STATUS_OPTIONS: Array<{ value: ContractStatus | ''; label: string }> = [
  { value: '', label: 'Все' },
  { value: 'active', label: 'Действующие' },
  { value: 'draft', label: 'Черновики' },
  { value: 'expired', label: 'Истёкшие' },
  { value: 'terminated', label: 'Расторгнутые' },
];

type StatusOption = ContractStatus | '';

const TYPE_LABEL: Record<ContractType, string> = {
  service: 'Сервисный',
  one_time: 'Разовый',
};

const STATUS_META: Record<ContractStatus, { label: string; variant: StatusBadgeVariant }> = {
  draft: { label: 'Черновик', variant: 'muted' },
  active: { label: 'Действует', variant: 'success' },
  expired: { label: 'Истёк', variant: 'warning' },
  terminated: { label: 'Расторгнут', variant: 'danger' },
};

interface ContractRow {
  id: string;
  contractNumber: string;
  clientId: string;
  clientDisplayName: string;
  type: ContractType;
  contractDate: string | Date;
  validUntil: string | Date | null;
  status: ContractStatus;
}

const PAGE_SIZE = 25;

export function ContractsListPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [status, setStatus] = useState<StatusOption>('active');
  const [page, setPage] = useState(1);

  const list = trpc.contracts.list.useQuery({
    search: debounced || undefined,
    status: (status || undefined),
    page,
  });

  const items = (list.data?.items ?? []) as ContractRow[];
  const total = list.data?.total ?? 0;

  const columns: Column<ContractRow>[] = [
    {
      key: 'contractNumber',
      label: 'Номер',
      className: 'font-mono text-xs',
      render: (c) => (
        <Link
          href={`/contracts/${c.id}`}
          className="text-foreground hover:text-primary font-medium"
        >
          {c.contractNumber}
        </Link>
      ),
    },
    {
      key: 'client',
      label: 'Клиент',
      render: (c) => (
        <Link
          href={`/clients/${c.clientId}`}
          className="text-muted-foreground hover:text-primary"
        >
          {c.clientDisplayName}
        </Link>
      ),
    },
    {
      key: 'type',
      label: 'Тип',
      className: 'text-xs',
      render: (c) => TYPE_LABEL[c.type],
    },
    {
      key: 'contractDate',
      label: 'Дата',
      className: 'text-xs',
      render: (c) => formatDate(c.contractDate),
    },
    {
      key: 'validUntil',
      label: 'Действует до',
      className: 'text-xs',
      render: (c) =>
        c.validUntil ? (
          formatDate(c.validUntil)
        ) : (
          <span className="text-muted-foreground">бессрочно</span>
        ),
    },
    {
      key: 'status',
      label: 'Статус',
      render: (c) => {
        const meta = STATUS_META[c.status];
        return <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>;
      },
    },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <FileSignature className="h-3.5 w-3.5" />
            Договоры
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Договоры с клиентами</h1>
          <p className="text-muted-foreground text-sm">
            Сервисные и разовые контракты — для бюджетников обязательны по 44-ФЗ
          </p>
        </div>
        <Link
          href="/contracts/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Новый договор
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Поиск по номеру, клиенту"
            className="bg-background w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StatusOption);
            setPage(1);
          }}
          className="bg-background rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Договоров не найдено"
        rowKey={(c) => c.id}
      />

      <Pagination
        page={page}
        total={total}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />
    </div>
  );
}

function formatDate(iso: string | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('ru-RU');
}
