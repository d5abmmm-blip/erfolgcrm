import { useState } from 'react';
import {
  TrendingUp,
  AlertTriangle,
  Clock,
  Wallet,
  Package,
  CalendarCheck,
  Receipt,
  FileDown,
  FileSpreadsheet,
  Loader2,
} from 'lucide-react';
import { Link } from 'wouter';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
// pdfmake/exceljs lazy-loaded only on button click — см. handleDailySummaryPdf/Xlsx ниже.

type Period = 'today' | 'week' | 'month' | 'quarter';

const PERIOD_LABEL: Record<Period, string> = {
  today: 'День',
  week: 'Неделя',
  month: 'Месяц',
  quarter: 'Квартал',
};

function formatRubFromKopecks(kopStr: string): string {
  const k = BigInt(kopStr);
  const rub = Number(k) / 100;
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(rub);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value);
}

export function DashboardPage() {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.user.role;

  if (role === 'director') {
    return <DirectorDashboard />;
  }
  return <SimpleDashboard role={role ?? 'dispatcher'} />;
}

/* ========================== DIRECTOR DASHBOARD ========================== */

function DirectorDashboard() {
  const [period, setPeriod] = useState<Period>('month');
  const metricsQ = trpc.dashboard.getMetrics.useQuery({ preset: period });
  const overdueQ = trpc.dashboard.listOverdueInvoices.useQuery({ limit: 5 });
  const slaQ = trpc.dashboard.listSlaAtRisk.useQuery({ limit: 5 });
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const [pdfBusy, setPdfBusy] = useState(false);
  const [xlsxBusy, setXlsxBusy] = useState(false);

  const fetchSummaryInput = async () => {
    const today = new Date().toISOString();
    const summary = await utils.dashboard.getDailySummary.fetch({ date: today });
    return {
      date: summary.date,
      metrics: summary.metrics,
      overdueInvoices: summary.overdueInvoices,
      slaAtRisk: summary.slaAtRisk,
      lowStock: summary.lowStock,
      maintenanceToday: summary.maintenanceToday.map((mr) => ({
        assetName: mr.assetName,
        responsibleName: mr.responsibleName,
        isOverdue: mr.isOverdue,
      })),
      closedTicketsToday: summary.closedTicketsToday,
      tenantDisplayName: me.data?.tenant.displayName,
    };
  };

  const handleDailySummaryPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const [{ printDailySummary }, summaryInput] = await Promise.all([
        import('../lib/pdf'),
        fetchSummaryInput(),
      ]);
      await printDailySummary(summaryInput);
    } finally {
      setPdfBusy(false);
    }
  };

  const handleDailySummaryXlsx = async () => {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try {
      const [{ downloadDailySummaryXlsx }, summaryInput] = await Promise.all([
        import('../lib/excel/daily-summary'),
        fetchSummaryInput(),
      ]);
      await downloadDailySummaryXlsx(summaryInput);
    } finally {
      setXlsxBusy(false);
    }
  };

  const m = metricsQ.data;

  const today = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold md:text-2xl">Сводка по сервисному центру</h2>
          <p className="text-muted-foreground text-sm">Сегодня · {today}</p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodTabs value={period} onChange={setPeriod} />
          <button
            type="button"
            onClick={handleDailySummaryPdf}
            disabled={pdfBusy}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-60"
          >
            {pdfBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="h-4 w-4" />
            )}
            Сводка дня · PDF
          </button>
          <button
            type="button"
            onClick={handleDailySummaryXlsx}
            disabled={xlsxBusy}
            className="bg-success text-success-foreground hover:bg-success/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-60"
          >
            {xlsxBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="h-4 w-4" />
            )}
            Excel
          </button>
        </div>
      </div>

      {metricsQ.isLoading && (
        <div className="bg-card flex items-center gap-3 rounded-lg border p-4">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">Загружаем метрики…</span>
        </div>
      )}

      {metricsQ.error && (
        <div className="bg-destructive/10 text-destructive rounded-lg border border-destructive/30 p-4 text-sm">
          Не удалось загрузить метрики: {metricsQ.error.message}
        </div>
      )}

      {m && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile
              title={`Выручка · ${PERIOD_LABEL[period].toLowerCase()}`}
              value={formatRubFromKopecks(m.revenuePeriodKopecks)}
              hint={`Закрытых нарядов на ${formatRubFromKopecks(m.revenueClosedPeriodKopecks)}`}
              tone="success"
              icon={Wallet}
            />
            <MetricTile
              title="Маржа"
              value={m.marginPercent !== null ? `${m.marginPercent.toFixed(1)}%` : '—'}
              hint={
                BigInt(m.marginPeriodKopecks) > 0n
                  ? formatRubFromKopecks(m.marginPeriodKopecks)
                  : 'нет закрытых нарядов'
              }
              tone={
                m.marginPercent === null
                  ? 'default'
                  : m.marginPercent < 20
                    ? 'danger'
                    : m.marginPercent < 35
                      ? 'warning'
                      : 'success'
              }
              icon={TrendingUp}
            />
            <MetricTile
              title="Дебиторка"
              value={formatRubFromKopecks(m.receivablesTotalKopecks)}
              hint={`Из них просрочено ${formatRubFromKopecks(m.overdueTotalKopecks)}`}
              tone={BigInt(m.overdueTotalKopecks) > 0n ? 'danger' : 'default'}
              icon={Receipt}
              href="/invoices?status=overdue"
            />
            <MetricTile
              title="Активные заявки"
              value={formatNumber(m.activeTicketsCount)}
              hint={
                m.slaAtRiskCount > 0
                  ? `На грани SLA: ${m.slaAtRiskCount}`
                  : 'все по плану'
              }
              tone={m.slaAtRiskCount > 0 ? 'warning' : 'default'}
              icon={Clock}
              href="/tickets"
            />
            <MetricTile
              title="Дефицит запчастей"
              value={`${formatNumber(m.lowStockCount)} SKU`}
              hint="ниже минимума"
              tone={m.lowStockCount > 0 ? 'warning' : 'default'}
              icon={Package}
              href="/inventory"
            />
            <MetricTile
              title="ТО на сегодня"
              value={formatNumber(m.todayMaintenanceCount)}
              hint={`${formatNumber(m.overdueMaintenanceCount)} просрочено`}
              tone={m.overdueMaintenanceCount > 0 ? 'warning' : 'default'}
              icon={CalendarCheck}
              href="/maintenance"
            />
            <MetricTile
              title="ЗП к выплате"
              value="—"
              hint="откройте «Зарплата»"
              icon={Wallet}
              href="/payroll"
            />
            <MetricTile
              title="Просроченных счетов"
              value={
                BigInt(m.overdueTotalKopecks) > 0n
                  ? formatRubFromKopecks(m.overdueTotalKopecks)
                  : '0 ₽'
              }
              hint="требуют напоминания"
              tone={BigInt(m.overdueTotalKopecks) > 0n ? 'danger' : 'success'}
              icon={AlertTriangle}
              href="/invoices?status=overdue"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <OverdueInvoicesCard rows={overdueQ.data ?? []} loading={overdueQ.isLoading} />
            <SlaAtRiskCard rows={slaQ.data ?? []} loading={slaQ.isLoading} />
          </div>
        </>
      )}
    </div>
  );
}

function OverdueInvoicesCard({
  rows,
  loading,
}: {
  rows: Array<{
    id: string;
    invoiceNumber: string;
    clientName: string | null;
    remainingKopecks: string;
    dueDate: string;
    daysOverdue: number;
  }>;
  loading: boolean;
}) {
  return (
    <section className="bg-card rounded-lg border">
      <div className="flex items-center justify-between border-b p-4">
        <h3 className="font-semibold">Просроченные счета</h3>
        <Link
          href="/invoices?status=overdue"
          className="text-primary text-sm hover:underline"
        >
          Все →
        </Link>
      </div>
      {loading ? (
        <div className="text-muted-foreground p-4 text-sm">Загружаем…</div>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground p-4 text-sm">Нет просроченных счетов</div>
      ) : (
        <div className="divide-y">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/invoices/${r.id}`}
              className="hover:bg-muted/50 flex items-center justify-between p-4 transition"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{r.invoiceNumber}</div>
                <div className="text-muted-foreground truncate text-xs">
                  {r.clientName ?? '—'} · просрочено {r.daysOverdue} дн.
                </div>
              </div>
              <div className="text-destructive text-sm font-semibold tabular-nums">
                {formatRubFromKopecks(r.remainingKopecks)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function SlaAtRiskCard({
  rows,
  loading,
}: {
  rows: Array<{
    id: string;
    ticketNumber: string;
    clientName: string | null;
    engineerName: string | null;
    hoursUntilSla: number;
  }>;
  loading: boolean;
}) {
  return (
    <section className="bg-card rounded-lg border">
      <div className="flex items-center justify-between border-b p-4">
        <h3 className="font-semibold">SLA в зоне риска</h3>
        <Link href="/tickets" className="text-primary text-sm hover:underline">
          Все заявки →
        </Link>
      </div>
      {loading ? (
        <div className="text-muted-foreground p-4 text-sm">Загружаем…</div>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground p-4 text-sm">Нет заявок на грани SLA</div>
      ) : (
        <div className="divide-y">
          {rows.map((r) => {
            const overdue = r.hoursUntilSla < 0;
            return (
              <Link
                key={r.id}
                href={`/tickets/${r.id}`}
                className="hover:bg-muted/50 flex items-center justify-between p-4 transition"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{r.ticketNumber}</div>
                  <div className="text-muted-foreground truncate text-xs">
                    {r.clientName ?? '—'} · {r.engineerName ?? 'не назначен'}
                  </div>
                </div>
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-xs font-medium tabular-nums',
                    overdue
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-warning/15 text-warning',
                  )}
                >
                  {overdue
                    ? `просрочено ${Math.abs(r.hoursUntilSla).toFixed(1)} ч`
                    : `через ${r.hoursUntilSla.toFixed(1)} ч`}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ========================== ОБЩИЕ КОМПОНЕНТЫ ========================== */

interface MetricTileProps {
  title: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  icon: typeof Wallet;
  href?: string;
}

function MetricTile({
  title,
  value,
  hint,
  tone = 'default',
  icon: Icon,
  href,
}: MetricTileProps) {
  const toneClasses = {
    default: 'border-border',
    warning: 'border-warning/40',
    danger: 'border-destructive/40',
    success: 'border-success/40',
  } as const;
  const toneText = {
    default: '',
    warning: 'text-warning',
    danger: 'text-destructive',
    success: 'text-success',
  } as const;

  const content = (
    <div
      className={cn(
        'bg-card flex h-full flex-col gap-2 rounded-lg border p-4 transition',
        toneClasses[tone],
        href && 'hover:border-primary/50 cursor-pointer',
      )}
    >
      <div className="flex items-start justify-between">
        <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          {title}
        </div>
        <Icon className={cn('h-4 w-4', toneText[tone] || 'text-muted-foreground')} />
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  );

  return href ? <Link href={href}>{content}</Link> : content;
}

function PeriodTabs({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  const periods: Period[] = ['today', 'week', 'month', 'quarter'];
  return (
    <div className="bg-secondary inline-flex rounded-md p-0.5 text-xs">
      {periods.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            'rounded px-2.5 py-1 font-medium transition',
            p === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {PERIOD_LABEL[p]}
        </button>
      ))}
    </div>
  );
}

/* ========================== SIMPLE DASHBOARD (НЕ ДИРЕКТОР) ========================== */

function SimpleDashboard({ role }: { role: 'director' | 'dispatcher' | 'engineer' }) {
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <div>
        <h2 className="text-xl font-semibold md:text-2xl">Рабочий стол</h2>
        <p className="text-muted-foreground text-sm">
          {role === 'dispatcher'
            ? 'Финансовая сводка доступна только директору. Ниже быстрые действия.'
            : 'Перейдите к мобильному интерфейсу для работы с заявками.'}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/tickets"
          className="bg-card hover:border-primary/50 rounded-lg border p-4 transition"
        >
          <div className="text-muted-foreground text-xs uppercase">Перейти</div>
          <div className="mt-1 text-lg font-semibold">Заявки</div>
          <p className="text-muted-foreground mt-1 text-sm">
            Список и канбан текущих заявок.
          </p>
        </Link>
        <Link
          href="/clients"
          className="bg-card hover:border-primary/50 rounded-lg border p-4 transition"
        >
          <div className="text-muted-foreground text-xs uppercase">Перейти</div>
          <div className="mt-1 text-lg font-semibold">Клиенты</div>
          <p className="text-muted-foreground mt-1 text-sm">
            База клиентов и техники.
          </p>
        </Link>
        <Link
          href="/inventory"
          className="bg-card hover:border-primary/50 rounded-lg border p-4 transition"
        >
          <div className="text-muted-foreground text-xs uppercase">Перейти</div>
          <div className="mt-1 text-lg font-semibold">Склад</div>
          <p className="text-muted-foreground mt-1 text-sm">Запчасти и закупки.</p>
        </Link>
      </div>
    </div>
  );
}
