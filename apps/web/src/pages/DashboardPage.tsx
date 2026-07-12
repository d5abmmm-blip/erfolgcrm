import { useState } from 'react';
import {
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Wallet,
  Package,
  CalendarCheck,
  CalendarDays,
  Receipt,
  Ticket,
  Target,
  FileDown,
  FileSpreadsheet,
  Loader2,
} from 'lucide-react';
import { Link } from 'wouter';
import { trpc } from '../lib/trpc';
import { openPrintWindow } from '../lib/open-print-window';
import { cn } from '../lib/utils';
import { AiDailySummaryCard } from '../components/AiDailySummaryCard';
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
  // ЗП к выплате за выбранный период (та же логика расчёта, что на /payroll).
  const payoutsQ = trpc.payroll.computePayouts.useQuery({ preset: period });
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
    const win = openPrintWindow();
    try {
      const [{ printDailySummary }, summaryInput] = await Promise.all([
        import('../lib/pdf'),
        fetchSummaryInput(),
      ]);
      await printDailySummary(summaryInput, win);
    } catch {
      win?.close();
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
    <div className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold md:text-2xl">Сводка по сервисному центру</h2>
          <p className="text-muted-foreground text-sm">Сегодня · {today}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodTabs value={period} onChange={setPeriod} />
          <button
            type="button"
            onClick={() => void handleDailySummaryPdf()}
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
            onClick={() => void handleDailySummaryXlsx()}
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

      <AiDailySummaryCard />

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
              title={`ЗП к выплате · ${PERIOD_LABEL[period].toLowerCase()}`}
              value={
                payoutsQ.data
                  ? formatRubFromKopecks(payoutsQ.data.grandTotalKopecks)
                  : payoutsQ.isLoading
                    ? '…'
                    : '—'
              }
              hint={
                payoutsQ.data
                  ? payoutsQ.data.rows.length > 0
                    ? `по ${payoutsQ.data.rows.length} инженерам, детали в «Зарплате»`
                    : 'нет закрытых нарядов за период'
                  : 'откройте «Зарплата»'
              }
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
    <section className="bg-card rounded-xl border shadow-sm">
      <div className="flex items-center justify-between border-b p-4">
        <h3 className="flex items-center gap-2.5 font-semibold">
          <span
            className={cn(
              'grid h-8 w-8 place-items-center rounded-lg',
              rows.length > 0
                ? 'bg-destructive/12 text-destructive'
                : 'bg-success/12 text-success',
            )}
          >
            <Receipt className="h-4 w-4" />
          </span>
          Просроченные счета
          {rows.length > 0 && (
            <span className="bg-destructive text-destructive-foreground rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
              {rows.length}
            </span>
          )}
        </h3>
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
        <div className="text-success flex items-center gap-2 p-4 text-sm">
          <CheckCircle2 className="h-4 w-4" />
          Нет просроченных счетов
        </div>
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
    <section className="bg-card rounded-xl border shadow-sm">
      <div className="flex items-center justify-between border-b p-4">
        <h3 className="flex items-center gap-2.5 font-semibold">
          <span
            className={cn(
              'grid h-8 w-8 place-items-center rounded-lg',
              rows.length > 0 ? 'bg-warning/15 text-warning' : 'bg-success/12 text-success',
            )}
          >
            <Clock className="h-4 w-4" />
          </span>
          SLA в зоне риска
          {rows.length > 0 && (
            <span className="bg-warning text-warning-foreground rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
              {rows.length}
            </span>
          )}
        </h3>
        <Link href="/tickets" className="text-primary text-sm hover:underline">
          Все заявки →
        </Link>
      </div>
      {loading ? (
        <div className="text-muted-foreground p-4 text-sm">Загружаем…</div>
      ) : rows.length === 0 ? (
        <div className="text-success flex items-center gap-2 p-4 text-sm">
          <CheckCircle2 className="h-4 w-4" />
          Нет заявок на грани SLA
        </div>
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
  // Цвет = смысл: зелёный «всё хорошо», янтарный «обрати внимание»,
  // красный «горит», голубой — нейтральная рабочая метрика.
  const TONE = {
    default: {
      chip: 'bg-primary/10 text-primary',
      value: 'text-foreground',
      hint: 'text-muted-foreground',
      edge: '',
    },
    success: {
      chip: 'bg-success/12 text-success',
      value: 'text-success',
      hint: 'text-muted-foreground',
      edge: 'bg-success',
    },
    warning: {
      chip: 'bg-warning/15 text-warning',
      value: 'text-foreground',
      hint: 'text-warning',
      edge: 'bg-warning',
    },
    danger: {
      chip: 'bg-destructive/12 text-destructive',
      value: 'text-destructive',
      hint: 'text-destructive/80',
      edge: 'bg-destructive',
    },
  } as const;
  const t = TONE[tone];

  const content = (
    <div
      className={cn(
        'bg-card relative flex h-full flex-col gap-2.5 overflow-hidden rounded-xl border p-4 shadow-sm transition-all',
        href && 'hover:border-primary/50 hover:shadow-md cursor-pointer',
      )}
    >
      {/* Цветное «ребро» слева — сигнал считывается боковым зрением. */}
      {t.edge && (
        <span
          className={cn('absolute inset-y-3 left-0 w-[3px] rounded-r-full', t.edge)}
          aria-hidden
        />
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          {title}
        </div>
        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', t.chip)}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className={cn('text-2xl font-semibold tabular-nums tracking-tight', t.value)}>
        {value}
      </div>
      {hint && <div className={cn('text-xs', t.hint)}>{hint}</div>}
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
  if (role === 'dispatcher') return <DispatcherDashboard />;
  // Инженер работает с мобильного интерфейса — здесь только подсказка-переход.
  return (
    <div className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-6">
      <div>
        <h2 className="text-xl font-semibold md:text-2xl">Рабочий стол</h2>
        <p className="text-muted-foreground text-sm">
          Перейдите к мобильному интерфейсу для работы с заявками.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/tickets" className="bg-card hover:border-primary/50 rounded-lg border p-4 transition">
          <div className="text-muted-foreground text-xs uppercase">Перейти</div>
          <div className="mt-1 text-lg font-semibold">Заявки</div>
        </Link>
      </div>
    </div>
  );
}

/**
 * Рабочий стол менеджера (диспетчера) — «что требует внимания сегодня».
 * Финансовая аналитика остаётся у директора; здесь — операционные счётчики
 * из navBadges (доступны staff), каждый ведёт в свой раздел.
 */
function DispatcherDashboard() {
  const nb = trpc.dashboard.navBadges.useQuery(undefined, { refetchInterval: 60_000 });
  const b = nb.data;
  return (
    <div className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-6">
      <div>
        <h2 className="text-xl font-semibold md:text-2xl">Рабочий стол</h2>
        <p className="text-muted-foreground text-sm">Что требует внимания сегодня</p>
      </div>

      <AiDailySummaryCard />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <AttentionTile label="Заявки на разбор" value={b?.ticketsAttention ?? 0} href="/tickets" icon={Ticket} />
        <AttentionTile label="Просрочено ТО" value={b?.maintenanceOverdue ?? 0} href="/maintenance" icon={CalendarCheck} bad />
        <AttentionTile label="Просроченные счета" value={b?.invoicesOverdue ?? 0} href="/finance/invoices" icon={Receipt} bad />
        <AttentionTile label="Мало на складе" value={b?.inventoryLowStock ?? 0} href="/inventory" icon={Package} bad />
        <AttentionTile label="Новые лиды" value={b?.leadsNew ?? 0} href="/leads" icon={Target} />
        <AttentionTile label="События сегодня" value={b?.calendarToday ?? 0} href="/calendar" icon={CalendarDays} />
      </div>

      <div>
        <div className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">Быстрые переходы</div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['/tickets', 'Заявки'],
              ['/clients', 'Клиенты'],
              ['/sales', 'Продажи'],
              ['/mail', 'Почта'],
              ['/finance', 'Касса'],
            ] as const
          ).map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="bg-card hover:border-primary/50 rounded-md border px-3 py-1.5 text-sm transition"
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function AttentionTile({
  label,
  value,
  href,
  icon: Icon,
  bad,
}: {
  label: string;
  value: number;
  href: string;
  icon: typeof Package;
  bad?: boolean;
}) {
  const active = value > 0;
  return (
    <Link
      href={href}
      className={cn(
        'bg-card relative flex items-center justify-between gap-3 overflow-hidden rounded-lg border p-4 transition hover:border-primary/50',
        active && bad && 'border-destructive/30',
      )}
    >
      <div>
        <div className="text-muted-foreground text-xs uppercase tracking-wide">{label}</div>
        <div
          className={cn(
            'mt-1 text-3xl font-semibold tabular-nums',
            !active ? 'text-muted-foreground' : bad ? 'text-destructive' : 'text-primary',
          )}
        >
          {value}
        </div>
      </div>
      <span
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-lg',
          active && bad
            ? 'bg-destructive/10 text-destructive'
            : active
              ? 'bg-primary/10 text-primary'
              : 'bg-secondary text-muted-foreground',
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
    </Link>
  );
}
