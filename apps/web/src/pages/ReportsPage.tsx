/**
 * Отчёты (перенос из v1 Reports.tsx) — периодная аналитика поверх SQL-агрегатов:
 * выручка по клиентам, загрузка инженеров, SLA, воронка лидов, дебиторка (директор).
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  BarChart3,
  Clock,
  Coins,
  Receipt,
  RefreshCw,
  Sparkles,
  Target,
  TrendingUp,
  Users as UsersIcon,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub } from '../lib/money';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';

type TabId = 'monthly' | 'revenue' | 'engineers' | 'profitability' | 'sla' | 'leads' | 'receivables';

const TABS: Array<{ id: TabId; label: string; icon: typeof TrendingUp; directorOnly?: boolean }> = [
  { id: 'monthly', label: 'Итог месяца', icon: Sparkles, directorOnly: true },
  { id: 'revenue', label: 'Выручка по клиентам', icon: TrendingUp },
  { id: 'engineers', label: 'Загрузка инженеров', icon: UsersIcon },
  { id: 'profitability', label: 'Рентабельность', icon: Coins, directorOnly: true },
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

      {/* Период (на вкладке «Итог месяца» — свой выбор месяца) */}
      {tab !== 'monthly' && (
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
      )}

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

      {tab === 'monthly' && isDirector && <MonthlySummaryReport />}
      {tab === 'revenue' && <RevenueReport period={period} />}
      {tab === 'engineers' && <EngineersReport period={period} />}
      {tab === 'profitability' && isDirector && <ProfitabilityReport period={period} />}
      {tab === 'sla' && <SlaReport period={period} />}
      {tab === 'leads' && <LeadsReport period={period} />}
      {tab === 'receivables' && isDirector && <ReceivablesReport />}
    </div>
  );
}

/* ───────────────────────── Итог месяца (AI) ───────────────────────── */

const MONTHS_RU_WEB = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

/** Последние `count` месяцев (включая текущий), от свежего к старому. */
function recentMonths(count: number): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    out.push({ value: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MONTHS_RU_WEB[m]} ${y}` });
  }
  return out;
}

function MonthlySummaryReport() {
  const months = useMemo(() => recentMonths(12), []);
  const [month, setMonth] = useState(() => months[0]?.value ?? '');
  const q = trpc.reports.monthlySummary.useQuery(
    { month },
    { staleTime: 5 * 60_000, refetchOnWindowFocus: false },
  );
  const res = q.data;

  return (
    <div className="space-y-5">
      {/* Выбор месяца + переген */}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="ms-month" className="text-muted-foreground text-sm">
          Месяц
        </label>
        <select
          id="ms-month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="bg-background focus:ring-primary/40 rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
        >
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            void q.refetch();
          }}
          disabled={q.isFetching}
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? 'animate-spin' : ''}`} />
          Сформировать заново
        </button>
      </div>

      {q.isLoading && (
        <p className="text-muted-foreground text-sm">Готовим итог месяца…</p>
      )}
      {q.error && <p className="text-destructive text-sm">{q.error.message}</p>}

      {res && (
        <>
          {/* AI-текст или деградация до фактов */}
          {res.text ? (
            <div className="border-primary/30 bg-card rounded-lg border p-4">
              <div className="text-primary mb-2 flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4" /> AI-итог · {res.monthLabel}
              </div>
              <div className="text-sm leading-relaxed whitespace-pre-wrap">{res.text}</div>
            </div>
          ) : (
            <div className="bg-card text-muted-foreground flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                AI-ассистент не настроен или временно недоступен — текст-сводку не показываем, но
                все цифры за {res.monthLabel} ниже актуальны. Подключить помощника можно в{' '}
                <Link href="/settings/ai" className="text-primary hover:underline">
                  Настройках → ИИ-ассистент
                </Link>
                .
              </span>
            </div>
          )}

          {/* Деньги (касса за месяц) */}
          <div>
            <h3 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <Coins className="h-4 w-4" /> Деньги (касса за {res.monthLabel})
            </h3>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Приход" value={formatRub(res.data.cash.incomeKopecks)} />
              <Kpi label="Расход" value={formatRub(res.data.cash.expenseKopecks)} />
              <Kpi
                label="Прибыль"
                value={formatRub(res.data.cash.profitKopecks)}
                tone={cashTone(res.data.cash.profitKopecks)}
              />
              <Kpi label="Остаток по счетам" value={formatRub(res.data.cash.balanceTotalKopecks)} />
            </div>
            {res.data.cash.topExpenses.length > 0 && (
              <p className="text-muted-foreground mt-2 text-xs">
                Крупнейшая статья расходов: {res.data.cash.topExpenses[0]!.name} —{' '}
                {formatRub(res.data.cash.topExpenses[0]!.amountKopecks)}.
              </p>
            )}
          </div>

          {/* Рентабельность за месяц */}
          <div>
            <h3 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <TrendingUp className="h-4 w-4" /> Рентабельность (закрытые наряды)
            </h3>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Выручка" value={formatRub(res.data.profit.revenueKopecks)} />
              <Kpi
                label="Маржа"
                value={formatRub(res.data.profit.marginKopecks)}
                tone={cashTone(res.data.profit.marginKopecks)}
              />
              <Kpi
                label="Маржа %"
                value={fmtPct(res.data.profit.marginPercent)}
                tone={cashTone(res.data.profit.marginKopecks)}
              />
              <Kpi label="Закрыто нарядов" value={String(res.data.profit.closedOrdersCount)} />
            </div>
            {(res.data.profit.topEngineer || res.data.profit.topEquipment) && (
              <p className="text-muted-foreground mt-2 text-xs">
                {res.data.profit.topEngineer && (
                  <>
                    Лучший инженер: {res.data.profit.topEngineer.name} (маржа{' '}
                    {formatRub(res.data.profit.topEngineer.marginKopecks)}).
                  </>
                )}{' '}
                {res.data.profit.topEquipment && (
                  <>
                    Самый прибыльный тип: {res.data.profit.topEquipment.name} (маржа{' '}
                    {formatRub(res.data.profit.topEquipment.marginKopecks)}).
                  </>
                )}
              </p>
            )}
          </div>

          {/* Дебиторка (сейчас) */}
          <div>
            <h3 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <Receipt className="h-4 w-4" /> Дебиторка (текущее состояние)
            </h3>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Kpi label="Должны всего" value={formatRub(res.data.receivables.totalRemainingKopecks)} />
              <Kpi
                label="Из них просрочено"
                value={formatRub(res.data.receivables.overdueRemainingKopecks)}
                tone={res.data.receivables.overdueRemainingKopecks !== '0' ? 'danger' : undefined}
              />
              <Kpi label="Должников" value={String(res.data.receivables.debtorCount)} />
            </div>
          </div>

          <p className="text-muted-foreground text-xs">
            Деньги и маржа — за выбранный месяц (по дате закрытия наряда). Дебиторка — текущее
            состояние долгов на сегодня. Виден только директору.
          </p>
        </>
      )}
    </div>
  );
}

/** Цвет суммы по знаку: плюс — зелёный, минус — красный. */
function cashTone(kopecks: string): 'danger' | 'success' | undefined {
  let v: bigint;
  try {
    v = BigInt(kopecks);
  } catch {
    return undefined;
  }
  return v > 0n ? 'success' : v < 0n ? 'danger' : undefined;
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

/* ───────────────────────── Рентабельность ───────────────────────── */

interface ProfitRow {
  key: string | null;
  name: string;
  closedOrdersCount: number;
  totalAmountKopecks: string;
  costAmountKopecks: string;
  marginAmountKopecks: string;
  marginPercent: number | null;
}

function fmtPct(p: number | null): string {
  if (p === null) return '—';
  return `${p.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`;
}

/** Цвет маржи по знаку: прибыль — зелёная, убыток — красный, ноль — приглушённый. */
function marginTextClass(marginKopecks: string): string {
  let m: bigint;
  try {
    m = BigInt(marginKopecks);
  } catch {
    return 'text-muted-foreground';
  }
  return m > 0n ? 'text-success' : m < 0n ? 'text-destructive' : 'text-muted-foreground';
}

function ProfitTable({ rows, firstColLabel }: { rows: ProfitRow[]; firstColLabel: string }) {
  const columns: Column<ProfitRow>[] = [
    { key: 'name', label: firstColLabel, render: (r) => <span className="font-medium">{r.name}</span> },
    {
      key: 'closed',
      label: 'Закрыто',
      className: 'tabular-nums text-xs text-right',
      headerClassName: 'text-right',
      render: (r) => r.closedOrdersCount,
    },
    {
      key: 'revenue',
      label: 'Выручка',
      className: 'tabular-nums text-xs font-medium text-right',
      headerClassName: 'text-right',
      render: (r) => formatRub(r.totalAmountKopecks),
    },
    {
      key: 'margin',
      label: 'Маржа',
      className: 'tabular-nums text-xs text-right',
      headerClassName: 'text-right',
      render: (r) => (
        <span className={marginTextClass(r.marginAmountKopecks)}>{formatRub(r.marginAmountKopecks)}</span>
      ),
    },
    {
      key: 'pct',
      label: 'Маржа %',
      className: 'tabular-nums text-xs text-right',
      headerClassName: 'text-right',
      render: (r) => fmtPct(r.marginPercent),
    },
  ];
  // Сентинел для null-строки («Не назначен»/«Без типа»); не '—', чтобы не совпасть
  // с реальным device_type, равным «—» (иначе дубль React key в таблице).
  return (
    <DataTable
      data={rows}
      columns={columns}
      emptyText="Нет данных за период"
      rowKey={(r) => r.key ?? '__none__'}
    />
  );
}

function ProfitabilityReport({ period }: { period: { from?: string; to?: string } }) {
  const q = trpc.reports.profitability.useQuery(period);
  if (q.isLoading) return <p className="text-muted-foreground text-sm">Загрузка…</p>;
  if (q.error) return <p className="text-destructive text-sm">{q.error.message}</p>;
  const d = q.data!;
  const summaryMargin = (() => {
    try {
      return BigInt(d.summary.marginAmountKopecks);
    } catch {
      return 0n;
    }
  })();
  const marginTone = summaryMargin > 0n ? 'success' : summaryMargin < 0n ? 'danger' : undefined;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Выручка (закрытые)" value={formatRub(d.summary.totalAmountKopecks)} />
        <Kpi label="Себестоимость" value={formatRub(d.summary.costAmountKopecks)} />
        <Kpi label="Маржа (прибыль)" value={formatRub(d.summary.marginAmountKopecks)} tone={marginTone} />
        <Kpi label="Маржа %" value={fmtPct(d.summary.marginPercent)} tone={marginTone} />
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <UsersIcon className="h-4 w-4" /> По инженерам
        </h3>
        <ProfitTable rows={d.byEngineer} firstColLabel="Инженер" />
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Coins className="h-4 w-4" /> По типу техники
        </h3>
        <ProfitTable rows={d.byEquipment} firstColLabel="Тип оборудования" />
      </div>

      <p className="text-muted-foreground text-xs">
        Рентабельность считается по дате закрытия наряда (сходится с «Маржа» на дашборде). «Не
        назначен» / «Без типа» — наряды без инженера или без указанного типа аппарата.
      </p>
    </div>
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

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'success' }) {
  const toneCls = tone === 'danger' ? 'text-destructive' : tone === 'success' ? 'text-success' : '';
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${toneCls}`}>{value}</div>
    </div>
  );
}
