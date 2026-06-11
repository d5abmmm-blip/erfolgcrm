/**
 * Отчёты (перенос из v1 Reports.tsx) — периодная аналитика поверх SQL-агрегатов:
 * выручка по клиентам, загрузка инженеров, SLA, воронка лидов, дебиторка (директор).
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  BarChart3,
  Clock,
  Receipt,
  Target,
  TrendingUp,
  Users as UsersIcon,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub } from '../lib/money';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';

type TabId = 'revenue' | 'engineers' | 'sla' | 'leads' | 'receivables';

const TABS: Array<{ id: TabId; label: string; icon: typeof TrendingUp; directorOnly?: boolean }> = [
  { id: 'revenue', label: 'Выручка по клиентам', icon: TrendingUp },
  { id: 'engineers', label: 'Загрузка инженеров', icon: UsersIcon },
  { id: 'sla', label: 'SLA', icon: Clock },
  { id: 'leads', label: 'Воронка лидов', icon: Target },
  { id: 'receivables', label: 'Дебиторка', icon: Receipt, directorOnly: true },
];

type Preset = 'month' | 'quarter' | 'year' | 'all';

function presetRange(p: Preset): { from?: string; to?: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now);
  if (p === 'month') from.setMonth(from.getMonth() - 1);
  else if (p === 'quarter') from.setMonth(from.getMonth() - 3);
  else if (p === 'year') from.setFullYear(from.getFullYear() - 1);
  else return {};
  return { from: from.toISOString().slice(0, 10), to };
}

export function ReportsPage() {
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });
  const isDirector = me.data?.user.role === 'director';

  const [tab, setTab] = useState<TabId>('revenue');
  const [preset, setPreset] = useState<Preset>('quarter');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const period = useMemo(() => {
    const base = presetRange(preset);
    return {
      from: customFrom || base.from,
      to: customTo || base.to,
    };
  }, [preset, customFrom, customTo]);

  const visibleTabs = TABS.filter((t) => !t.directorOnly || isDirector);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <div>
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
          <BarChart3 className="h-3.5 w-3.5" />
          Отчёты
        </div>
        <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Аналитика за период</h1>
        <p className="text-muted-foreground text-sm">
          Выручка, нагрузка, SLA и воронка — агрегаты считаются на сервере
        </p>
      </div>

      {/* Период */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="bg-secondary inline-flex rounded-md p-0.5">
          {(
            [
              ['month', 'Месяц'],
              ['quarter', 'Квартал'],
              ['year', 'Год'],
              ['all', 'Всё время'],
            ] as Array<[Preset, string]>
          ).map(([p, label]) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setPreset(p);
                setCustomFrom('');
                setCustomTo('');
              }}
              className={
                'rounded px-2.5 py-1 text-xs transition ' +
                (preset === p && !customFrom && !customTo
                  ? 'bg-background text-foreground font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground')
              }
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="date"
          value={customFrom}
          onChange={(e) => setCustomFrom(e.target.value)}
          className="bg-background focus:ring-primary/40 rounded-md border px-2 py-1.5 text-xs outline-none focus:ring-2"
          aria-label="Период с"
        />
        <span className="text-muted-foreground text-xs">—</span>
        <input
          type="date"
          value={customTo}
          onChange={(e) => setCustomTo(e.target.value)}
          className="bg-background focus:ring-primary/40 rounded-md border px-2 py-1.5 text-xs outline-none focus:ring-2"
          aria-label="Период по"
        />
      </div>

      {/* Вкладки */}
      <div className="flex flex-wrap gap-1 border-b">
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={
                'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition ' +
                (tab === t.id
                  ? 'border-primary text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground border-transparent')
              }
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'revenue' && <RevenueReport period={period} />}
      {tab === 'engineers' && <EngineersReport period={period} />}
      {tab === 'sla' && <SlaReport period={period} />}
      {tab === 'leads' && <LeadsReport period={period} />}
      {tab === 'receivables' && isDirector && <ReceivablesReport />}
    </div>
  );
}

/* ───────────────────────── Выручка по клиентам ───────────────────────── */

function RevenueReport({ period }: { period: { from?: string; to?: string } }) {
  const q = trpc.reports.revenueByClient.useQuery(period);
  interface Row {
    clientId: string | null;
    clientDisplayName: string;
    ticketsCount: number;
    closedCount: number;
    totalAmountKopecks: string;
    paidAmountKopecks: string;
  }
  const items = (q.data ?? []) as Row[];
  const columns: Column<Row>[] = [
    {
      key: 'client',
      label: 'Клиент',
      render: (r) =>
        r.clientId ? (
          <Link href={`/clients/${r.clientId}`} className="hover:text-primary font-medium">
            {r.clientDisplayName}
          </Link>
        ) : (
          r.clientDisplayName
        ),
    },
    { key: 'tickets', label: 'Заявок', className: 'tabular-nums text-xs', render: (r) => r.ticketsCount },
    { key: 'closed', label: 'Закрыто', className: 'tabular-nums text-xs', render: (r) => r.closedCount },
    {
      key: 'total',
      label: 'Сумма нарядов',
      className: 'tabular-nums text-xs font-medium',
      render: (r) => formatRub(r.totalAmountKopecks),
    },
    {
      key: 'paid',
      label: 'Оплачено',
      className: 'tabular-nums text-xs',
      render: (r) => formatRub(r.paidAmountKopecks),
    },
  ];
  return (
    <DataTable
      data={items}
      columns={columns}
      loading={q.isLoading}
      error={q.error ? { message: q.error.message } : null}
      emptyText="Нет данных за период"
      rowKey={(r) => r.clientId ?? '—'}
    />
  );
}

/* ───────────────────────── Загрузка инженеров ───────────────────────── */

function EngineersReport({ period }: { period: { from?: string; to?: string } }) {
  const q = trpc.reports.engineerPerformance.useQuery(period);
  interface Row {
    engineerId: string | null;
    engineerName: string;
    ticketsCount: number;
    closedCount: number;
    totalAmountKopecks: string;
    avgCloseDays: number | null;
  }
  const items = (q.data ?? []) as Row[];
  const columns: Column<Row>[] = [
    { key: 'name', label: 'Инженер', render: (r) => <span className="font-medium">{r.engineerName}</span> },
    { key: 'tickets', label: 'Заявок', className: 'tabular-nums text-xs', render: (r) => r.ticketsCount },
    { key: 'closed', label: 'Закрыто', className: 'tabular-nums text-xs', render: (r) => r.closedCount },
    {
      key: 'revenue',
      label: 'Выручка (наряды)',
      className: 'tabular-nums text-xs font-medium',
      render: (r) => formatRub(r.totalAmountKopecks),
    },
    {
      key: 'avg',
      label: 'Ср. время закрытия',
      className: 'tabular-nums text-xs',
      render: (r) =>
        r.avgCloseDays === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `${r.avgCloseDays} дн.`
        ),
    },
  ];
  return (
    <DataTable
      data={items}
      columns={columns}
      loading={q.isLoading}
      error={q.error ? { message: q.error.message } : null}
      emptyText="Нет данных по инженерам за период"
      rowKey={(r) => r.engineerId ?? 'unassigned'}
    />
  );
}

/* ───────────────────────────── SLA ─────────────────────────────── */

const PRIORITY_LABEL: Record<string, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
  urgent: 'Срочный',
};

function SlaReport({ period }: { period: { from?: string; to?: string } }) {
  const q = trpc.reports.slaCompliance.useQuery(period);
  if (q.isLoading) return <p className="text-muted-foreground text-sm">Загрузка…</p>;
  if (q.error)
    return <p className="text-destructive text-sm">{q.error.message}</p>;
  const d = q.data!;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Закрыто с SLA" value={String(d.totalTracked)} />
        <Kpi label="В срок" value={String(d.onTime)} />
        <Kpi label="С опозданием" value={String(d.late)} tone={d.late > 0 ? 'danger' : undefined} />
        <Kpi
          label="Соблюдение SLA"
          value={d.rate === null ? '—' : `${d.rate}%`}
          tone={d.rate !== null && d.rate < 80 ? 'danger' : undefined}
        />
      </div>
      {d.byPriority.length > 0 && (
        <div className="bg-card rounded-lg border p-4">
          <h3 className="mb-2 text-sm font-semibold">По приоритетам</h3>
          <ul className="space-y-1.5">
            {d.byPriority.map((p) => (
              <li key={p.priority} className="flex items-center justify-between text-sm">
                <span>{PRIORITY_LABEL[p.priority] ?? p.priority}</span>
                <span className="tabular-nums text-xs">
                  {p.onTime}/{p.totalTracked} в срок ·{' '}
                  <span className="font-medium">{p.rate === null ? '—' : `${p.rate}%`}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.totalTracked === 0 && (
        <p className="text-muted-foreground text-sm">
          За период нет закрытых заявок с заданным SLA.
        </p>
      )}
    </div>
  );
}

/* ───────────────────────── Воронка лидов ───────────────────────── */

const LEAD_LABEL: Record<string, string> = {
  new: 'Новые',
  contacted: 'Контакт',
  proposal: 'КП',
  negotiation: 'Переговоры',
  won: 'Выиграны',
  lost: 'Проиграны',
};
const LEAD_ORDER = ['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost'];

function LeadsReport({ period }: { period: { from?: string; to?: string } }) {
  const q = trpc.reports.leadsFunnel.useQuery(period);
  if (q.isLoading) return <p className="text-muted-foreground text-sm">Загрузка…</p>;
  if (q.error) return <p className="text-destructive text-sm">{q.error.message}</p>;
  const d = q.data!;
  const fmtRubNum = (n: number) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);
  const sorted = [...d.byStatus].sort(
    (a, b) => LEAD_ORDER.indexOf(a.status) - LEAD_ORDER.indexOf(b.status),
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Лидов за период" value={String(d.total)} />
        <Kpi label="Конверсия" value={d.conversion === null ? '—' : `${d.conversion}%`} />
        <Kpi label="Потенциал" value={fmtRubNum(d.totalPotentialRub)} />
        <Kpi label="Выручка (won)" value={fmtRubNum(d.wonRevenueRub)} />
      </div>
      <div className="bg-card rounded-lg border p-4">
        <h3 className="mb-2 text-sm font-semibold">По стадиям</h3>
        {sorted.length === 0 ? (
          <p className="text-muted-foreground text-sm">Лидов за период нет.</p>
        ) : (
          <ul className="space-y-1.5">
            {sorted.map((s) => (
              <li key={s.status} className="flex items-center justify-between text-sm">
                <span>{LEAD_LABEL[s.status] ?? s.status}</span>
                <span className="tabular-nums text-xs">
                  {s.count} шт. · <span className="font-medium">{fmtRubNum(s.valueRub)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Полная воронка с действиями — на странице{' '}
        <Link href="/leads" className="text-primary hover:underline">
          Лиды
        </Link>
        .
      </p>
    </div>
  );
}

/* ───────────────────────────── Дебиторка ───────────────────────── */

function ReceivablesReport() {
  const q = trpc.reports.receivables.useQuery();
  interface Row {
    invoiceId: string;
    invoiceNumber: string;
    clientId: string | null;
    clientDisplayName: string;
    status: 'issued' | 'partially_paid' | 'overdue';
    dueDate: string;
    totalAmountKopecks: string;
    paidAmountKopecks: string;
    remainingKopecks: string;
    overdueDays: number;
  }
  const items = (q.data?.items ?? []) as Row[];
  const columns: Column<Row>[] = [
    {
      key: 'number',
      label: 'Счёт',
      className: 'font-mono text-xs',
      render: (r) => (
        <Link href={`/invoices/${r.invoiceId}`} className="hover:text-primary font-medium">
          {r.invoiceNumber}
        </Link>
      ),
    },
    {
      key: 'client',
      label: 'Клиент',
      className: 'text-xs',
      render: (r) =>
        r.clientId ? (
          <Link href={`/clients/${r.clientId}`} className="text-muted-foreground hover:text-primary">
            {r.clientDisplayName}
          </Link>
        ) : (
          r.clientDisplayName
        ),
    },
    {
      key: 'due',
      label: 'Срок оплаты',
      className: 'text-xs tabular-nums',
      render: (r) => new Date(r.dueDate).toLocaleDateString('ru-RU'),
    },
    {
      key: 'remaining',
      label: 'Остаток',
      className: 'tabular-nums text-xs font-medium',
      render: (r) => formatRub(r.remainingKopecks),
    },
    {
      key: 'overdue',
      label: 'Просрочка',
      render: (r) =>
        r.overdueDays > 0 ? (
          <StatusBadge variant="danger" compact>
            {r.overdueDays} дн.
          </StatusBadge>
        ) : (
          <StatusBadge variant="success" compact>
            в срок
          </StatusBadge>
        ),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-2">
        <Kpi
          label="Дебиторка всего"
          value={q.data ? formatRub(q.data.totalRemainingKopecks) : '—'}
        />
        <Kpi
          label="Из них просрочено"
          value={q.data ? formatRub(q.data.overdueRemainingKopecks) : '—'}
          tone={q.data && q.data.overdueRemainingKopecks !== '0' ? 'danger' : undefined}
        />
      </div>
      <DataTable
        data={items}
        columns={columns}
        loading={q.isLoading}
        error={q.error ? { message: q.error.message } : null}
        emptyText="Все счета оплачены"
        rowKey={(r) => r.invoiceId}
      />
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold tabular-nums ${tone === 'danger' ? 'text-destructive' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}
