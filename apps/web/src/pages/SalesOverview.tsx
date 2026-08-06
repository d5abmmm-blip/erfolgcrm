/**
 * Вкладка «Обзор» раздела продаж: KPI за период (выручка/затраты/прибыль/маржа/
 * средний чек/не оплачено) со сравнением с прошлым периодом, помесячная разбивка
 * (столбики «затраты + прибыль» = выручка) и топ клиентов/товаров. Excel-выгрузка.
 * Данные — trpc.sales.analytics. Считается по дате продажи; отменённые исключены.
 */
import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Loader2, Sheet } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRubWhole } from '../lib/money';
import { monthLabel } from '../lib/cash-format';
import { downloadSalesAnalyticsXlsx } from '../lib/excel/sales';

interface Period {
  from?: string;
  to?: string;
}

export function SalesOverview({ period, periodLabel }: { period: Period; periodLabel: string }) {
  const q = trpc.sales.analytics.useQuery(period);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  if (q.isLoading) {
    return <p className="text-muted-foreground text-sm">Загрузка…</p>;
  }
  if (q.error) {
    return (
      <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm">
        {q.error.message}
      </div>
    );
  }
  const a = q.data;
  if (!a) return null;
  const s = a.summary;
  const hasData = s.salesCount > 0;

  const onExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const safe = periodLabel
        .replace(/[^\wа-яё\- ]/gi, '')
        .trim()
        .replace(/\s+/g, '_');
      await downloadSalesAnalyticsXlsx(a, periodLabel, `Продажи_${safe || 'период'}.xlsx`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Не удалось собрать Excel');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Показатели за период — <span className="text-foreground font-medium">{periodLabel}</span>.
          Считается по дате продажи; отменённые не учитываются.
        </p>
        <button
          type="button"
          onClick={() => void onExport()}
          disabled={exporting || !hasData}
          title="Скачать обзор и помесячную разбивку в Excel"
          className="bg-secondary hover:bg-secondary/70 inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sheet className="h-4 w-4" />}
          {exporting ? 'Собираю…' : 'Excel'}
        </button>
      </div>
      {exportError && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
          {exportError}
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Выручка"
          value={formatRubWhole(s.revenueKopecks)}
          delta={pctDelta(s.revenueKopecks, s.previous?.revenueKopecks)}
          goodWhenUp
        />
        <StatTile
          label="Затраты"
          value={formatRubWhole(s.costKopecks)}
          delta={pctDelta(s.costKopecks, s.previous?.costKopecks)}
          goodWhenUp={false}
        />
        <StatTile
          label="Прибыль"
          value={formatRubWhole(s.profitKopecks)}
          tone={BigInt(s.profitKopecks) >= 0n ? 'success' : 'danger'}
          delta={pctDelta(s.profitKopecks, s.previous?.profitKopecks)}
          goodWhenUp
        />
        <StatTile
          label="Маржа"
          value={s.marginPercent === null ? '—' : `${s.marginPercent}%`}
          hint="прибыль ÷ выручка"
        />
        <StatTile
          label="Продаж"
          value={String(s.salesCount)}
          hint={hasData ? `ср. чек ${formatRubWhole(s.avgCheckKopecks)}` : undefined}
        />
        <StatTile
          label="Не оплачено"
          value={formatRubWhole(s.unpaidKopecks)}
          tone={BigInt(s.unpaidKopecks) > 0n ? 'danger' : undefined}
          hint={s.unpaidCount > 0 ? `${s.unpaidCount} продаж(и)` : 'всё оплачено'}
        />
      </div>

      {!hasData ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
          За выбранный период продаж нет. Смените период или добавьте продажу.
        </div>
      ) : (
        <>
          {/* По месяцам */}
          <div className="bg-card rounded-lg border p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">По месяцам</h3>
              <div className="text-muted-foreground flex items-center gap-3 text-xs">
                <span className="inline-flex items-center gap-1">
                  <span className="bg-primary/50 h-2.5 w-2.5 rounded-sm" /> Затраты
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="bg-success h-2.5 w-2.5 rounded-sm" /> Прибыль
                </span>
              </div>
            </div>
            <MonthlyBars rows={a.byMonth} />
          </div>

          {/* Топы */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TopCard
              title="Топ клиентов"
              rows={a.topClients.map((c) => ({
                name: c.clientName,
                revenueKopecks: c.revenueKopecks,
                profitKopecks: c.profitKopecks,
                sub: `${c.salesCount} продаж(и)`,
              }))}
            />
            <TopCard
              title="Топ товаров"
              rows={a.topProducts.map((p) => ({
                name: p.name,
                revenueKopecks: p.revenueKopecks,
                profitKopecks: p.profitKopecks,
                sub: `${p.quantity} шт`,
              }))}
            />
          </div>
        </>
      )}
    </div>
  );
}

interface Delta {
  pct: number;
  up: boolean;
}

/** Процентное изменение cur к prev; null если prev пуст/ноль. */
function pctDelta(curStr: string, prevStr: string | undefined): Delta | null {
  if (prevStr === undefined) return null;
  const prev = Number(BigInt(prevStr));
  const cur = Number(BigInt(curStr));
  if (prev === 0) return null;
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return null;
  return { pct, up: pct > 0 };
}

function StatTile({
  label,
  value,
  hint,
  tone,
  delta,
  goodWhenUp,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'success' | 'danger';
  delta?: Delta | null;
  goodWhenUp?: boolean;
}) {
  const valueColor =
    tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : '';
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      <div className={'mt-1 text-lg font-semibold tabular-nums ' + valueColor}>{value}</div>
      {delta ? (
        <DeltaBadge delta={delta} goodWhenUp={goodWhenUp ?? true} />
      ) : hint ? (
        <div className="text-muted-foreground mt-0.5 text-[11px]">{hint}</div>
      ) : null}
    </div>
  );
}

function DeltaBadge({ delta, goodWhenUp }: { delta: Delta; goodWhenUp: boolean }) {
  const good = delta.up === goodWhenUp;
  const Icon = delta.up ? ArrowUpRight : ArrowDownRight;
  return (
    <div
      className={
        'mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium ' +
        (good ? 'text-success' : 'text-destructive')
      }
      title="к прошлому периоду"
    >
      <Icon className="h-3 w-3" />
      {Math.abs(delta.pct)}%
    </div>
  );
}

function MonthlyBars({
  rows,
}: {
  rows: Array<{
    month: string;
    revenueKopecks: string;
    costKopecks: string;
    profitKopecks: string;
    salesCount: number;
  }>;
}) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">Нет продаж за период.</p>;
  }
  const max = Math.max(1, ...rows.map((r) => Number(BigInt(r.revenueKopecks))));
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const rev = Number(BigInt(r.revenueKopecks));
        const cost = Number(BigInt(r.costKopecks));
        const barPct = (rev / max) * 100;
        const costPct = rev > 0 ? Math.min(100, (cost / rev) * 100) : 0;
        const profitPct = Math.max(0, 100 - costPct);
        return (
          <div key={r.month} className="flex items-center gap-3">
            <span className="text-muted-foreground w-16 shrink-0 text-xs">
              {monthLabel(r.month)} {r.month.slice(2, 4)}
            </span>
            <div className="bg-muted relative h-5 flex-1 overflow-hidden rounded">
              <div
                className="absolute inset-y-0 left-0 flex h-full"
                style={{ width: `${barPct}%` }}
              >
                <div className="bg-primary/50 h-full" style={{ width: `${costPct}%` }} />
                <div className="bg-success h-full" style={{ width: `${profitPct}%` }} />
              </div>
            </div>
            <span className="w-48 shrink-0 text-right text-xs tabular-nums">
              <span className="font-medium">{formatRubWhole(r.revenueKopecks)}</span>
              <span className="text-muted-foreground">
                {' '}
                · приб {formatRubWhole(r.profitKopecks)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TopCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ name: string; revenueKopecks: string; profitKopecks: string; sub: string }>;
}) {
  return (
    <div className="bg-card rounded-lg border p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Нет данных за период.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground mr-1.5 tabular-nums">{i + 1}.</span>
                {r.name}
                <span className="text-muted-foreground ml-1 text-xs">· {r.sub}</span>
              </span>
              <span className="shrink-0 text-right tabular-nums">
                <span className="font-medium">{formatRubWhole(r.revenueKopecks)}</span>
                <span className="text-success ml-1.5 text-xs">
                  +{formatRubWhole(r.profitKopecks)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
