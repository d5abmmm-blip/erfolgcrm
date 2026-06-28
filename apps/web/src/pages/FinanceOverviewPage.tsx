/**
 * /finance — Обзор кассы: остатки по счетам, приход/расход/разница за период,
 * помесячная динамика, расходы по статьям, последние операции.
 * RBAC: staff (директор + диспетчер). Графики — самописные (библиотеки нет).
 */
import { useState } from 'react';
import { Link } from 'wouter';
import {
  Banknote,
  CreditCard,
  Landmark,
  Wallet,
  TrendingUp,
  TrendingDown,
  Scale,
  ArrowRight,
  Plus,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { formatRub, formatRubWhole } from '../lib/money';
import { monthLabel } from '../lib/cash-format';
import { FinanceTabs } from '../components/finance/FinanceTabs';
import { CashTransactionModal } from '../components/finance/CashTransactionModal';
import { CASH_ACCOUNT_KIND_LABEL, CASH_TX_KIND_META } from '../lib/dictionaries';

type Preset = 'today' | 'week' | 'month' | 'quarter' | 'year';
const PRESET_LABEL: Record<Preset, string> = {
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
  quarter: 'Квартал',
  year: 'Год',
};

const ACCOUNT_ICON = { cash: Banknote, bank: Landmark, card: CreditCard } as const;

/** BigInt без падения: пустое/кривое значение (рассинхрон версий) → 0n, а не краш страницы. */
function safeBig(v: string | number | null | undefined): bigint {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
}

export function FinanceOverviewPage() {
  const [preset, setPreset] = useState<Preset>('today');
  const [txOpen, setTxOpen] = useState(false);
  const q = trpc.cash.overview.useQuery({ preset });
  const data = q.data;

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
      <FinanceTabs />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">Касса</h1>
        <div className="flex items-center gap-2">
          <PeriodTabs value={preset} onChange={setPreset} />
          <button
            type="button"
            onClick={() => setTxOpen(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Операция
          </button>
        </div>
      </div>

      {q.isLoading && (
        <div className="text-muted-foreground bg-card rounded-lg border p-6 text-sm">Загружаем…</div>
      )}
      {q.error && (
        <div className="text-destructive bg-destructive/10 border-destructive/30 rounded-lg border p-4 text-sm">
          Не удалось загрузить: {q.error.message}
        </div>
      )}

      {data && (
        <>
          {/* Собрано за период — главный вопрос менеджера «сколько сегодня?» */}
          <CollectedHero
            label={PRESET_LABEL[preset].toLowerCase()}
            totalKopecks={data.summary.incomeKopecks}
            byKind={data.summary.incomeByKind}
          />

          {/* Остатки по счетам */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <BalanceCard
              title="Всего денег"
              value={formatRubWhole(data.balances.totalKopecks)}
              hint={`Наличные ${formatRubWhole(data.balances.cashKopecks)} · Безнал ${formatRubWhole(data.balances.nonCashKopecks)}`}
              icon={Wallet}
              accent
            />
            {data.balances.accounts.map((a) => {
              const Icon = ACCOUNT_ICON[a.kind] ?? Wallet;
              const neg = safeBig(a.balanceKopecks) < 0n;
              return (
                <BalanceCard
                  key={a.id}
                  title={a.name}
                  value={formatRubWhole(a.balanceKopecks)}
                  hint={CASH_ACCOUNT_KIND_LABEL[a.kind]}
                  icon={Icon}
                  danger={neg}
                />
              );
            })}
            {data.balances.accounts.length === 0 && (
              <div className="text-muted-foreground bg-card col-span-full rounded-xl border border-dashed p-4 text-sm">
                Счетов пока нет.{' '}
                <Link href="/finance/accounts" className="text-primary hover:underline">
                  Завести счёт
                </Link>
              </div>
            )}
          </div>

          {/* KPI за период (приход вынесен в герой «Собрано» выше) */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiCard
              title={`Расход · ${PRESET_LABEL[preset].toLowerCase()}`}
              value={formatRubWhole(data.summary.expenseKopecks)}
              icon={TrendingDown}
              tone="danger"
            />
            <KpiCard
              title={`Разница (приход − расход) · ${PRESET_LABEL[preset].toLowerCase()}`}
              value={formatRubWhole(data.summary.profitKopecks)}
              icon={Scale}
              tone={safeBig(data.summary.profitKopecks) >= 0n ? 'success' : 'danger'}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MonthlyFlowCard data={data.monthly} />
            <ExpenseByCategoryCard
              rows={data.summary.expenseByCategory}
              totalKopecks={data.summary.expenseKopecks}
            />
          </div>

          <RecentTransactionsCard rows={data.recent} />
        </>
      )}

      <CashTransactionModal open={txOpen} onClose={() => setTxOpen(false)} />
    </div>
  );
}

/* ───────────────────────────── карточки ───────────────────────────── */

function BalanceCard({
  title,
  value,
  hint,
  icon: Icon,
  accent,
  danger,
}: {
  title: string;
  value: string;
  hint?: string;
  icon: typeof Wallet;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      className={cn(
        'bg-card relative flex flex-col gap-2 overflow-hidden rounded-xl border p-4 shadow-sm',
        accent && 'ring-primary/20 ring-1',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{title}</div>
        <span
          className={cn(
            'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
            accent ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground',
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className={cn('text-2xl font-semibold tabular-nums tracking-tight', danger && 'text-destructive')}>
        {value}
      </div>
      {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  );
}

function KpiCard({
  title,
  value,
  icon: Icon,
  tone,
}: {
  title: string;
  value: string;
  icon: typeof Wallet;
  tone: 'success' | 'danger';
}) {
  return (
    <div className="bg-card relative flex flex-col gap-2 overflow-hidden rounded-xl border p-4 shadow-sm">
      <span
        className={cn('absolute inset-y-3 left-0 w-[3px] rounded-r-full', tone === 'success' ? 'bg-success' : 'bg-destructive')}
        aria-hidden
      />
      <div className="flex items-start justify-between gap-2">
        <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{title}</div>
        <span
          className={cn(
            'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
            tone === 'success' ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive',
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className={cn('text-2xl font-semibold tabular-nums tracking-tight', tone === 'success' ? 'text-success' : 'text-destructive')}>
        {value}
      </div>
    </div>
  );
}

/* ─────────────────────── «Собрано» за период ─────────────────────── */

function CollectedHero({
  label,
  totalKopecks,
  byKind,
}: {
  label: string;
  totalKopecks?: string;
  // byKind может отсутствовать (старый бэкенд / рассинхрон версий) — не должно ронять страницу.
  byKind?: { cashKopecks?: string; cardKopecks?: string; bankKopecks?: string } | null;
}) {
  const k = byKind ?? {};
  return (
    <section className="bg-card rounded-xl border p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div>
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
            <TrendingUp className="text-success h-4 w-4" />
            Собрано · {label}
          </div>
          <div className="text-success mt-1 text-3xl font-semibold tabular-nums tracking-tight md:text-4xl">
            {formatRubWhole(totalKopecks ?? '0')}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <MethodChip icon={Banknote} label="Наличными" value={k.cashKopecks ?? '0'} />
          <MethodChip icon={CreditCard} label="Картой" value={k.cardKopecks ?? '0'} />
          <MethodChip icon={Landmark} label="Безнал" value={k.bankKopecks ?? '0'} />
        </div>
      </div>
    </section>
  );
}

function MethodChip({ icon: Icon, label, value }: { icon: typeof Wallet; label: string; value: string }) {
  return (
    <div className="bg-secondary/60 inline-flex items-center gap-2.5 rounded-lg px-3 py-2">
      <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
      <div className="leading-tight">
        <div className="text-muted-foreground text-[11px]">{label}</div>
        <div className="text-sm font-semibold tabular-nums">{formatRubWhole(value)}</div>
      </div>
    </div>
  );
}

/* ───────────────────────────── графики ───────────────────────────── */

function MonthlyFlowCard({ data }: { data: Array<{ month: string; incomeKopecks: string; expenseKopecks: string }> }) {
  const max = data.reduce((m, r) => {
    const v = Math.max(Number(r.incomeKopecks), Number(r.expenseKopecks));
    return v > m ? v : m;
  }, 0);
  return (
    <section className="bg-card rounded-xl border p-4 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold">Динамика по месяцам</h3>
      {data.length === 0 || max === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm">Пока нет операций</div>
      ) : (
        <>
          <div className="flex items-end justify-between gap-2" style={{ height: 140 }}>
            {data.map((r) => {
              const incH = Math.round((Number(r.incomeKopecks) / max) * 120);
              const expH = Math.round((Number(r.expenseKopecks) / max) * 120);
              return (
                <div key={r.month} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex h-[120px] items-end gap-1">
                    <div
                      className="bg-success/80 w-3 rounded-t"
                      style={{ height: Math.max(incH, 2) }}
                      title={`Приход: ${formatRub(r.incomeKopecks)}`}
                    />
                    <div
                      className="bg-destructive/70 w-3 rounded-t"
                      style={{ height: Math.max(expH, 2) }}
                      title={`Расход: ${formatRub(r.expenseKopecks)}`}
                    />
                  </div>
                  <span className="text-muted-foreground text-[11px]">{monthLabel(r.month)}</span>
                </div>
              );
            })}
          </div>
          <div className="text-muted-foreground mt-3 flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="bg-success/80 h-2.5 w-2.5 rounded-sm" /> Приход
            </span>
            <span className="flex items-center gap-1.5">
              <span className="bg-destructive/70 h-2.5 w-2.5 rounded-sm" /> Расход
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function ExpenseByCategoryCard({
  rows,
  totalKopecks,
}: {
  rows: Array<{ categoryId: string | null; categoryName: string; amountKopecks: string }>;
  totalKopecks: string;
}) {
  const total = Number(totalKopecks);
  const top = rows.slice(0, 6);
  return (
    <section className="bg-card rounded-xl border p-4 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold">Расходы по статьям</h3>
      {top.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm">Нет расходов за период</div>
      ) : (
        <div className="space-y-2.5">
          {top.map((r) => {
            const pct = total > 0 ? Math.round((Number(r.amountKopecks) / total) * 100) : 0;
            return (
              <div key={r.categoryId ?? 'none'}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="truncate">{r.categoryName}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatRubWhole(r.amountKopecks)} · {pct}%
                  </span>
                </div>
                <div className="bg-secondary h-2 overflow-hidden rounded-full">
                  <div className="bg-primary h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RecentTransactionsCard({
  rows,
}: {
  rows: Array<{
    id: string;
    kind: 'income' | 'expense' | 'transfer';
    accountName: string | null;
    counterAccountName: string | null;
    categoryName: string | null;
    amountKopecks: string;
    occurredOn: string;
    comment: string | null;
  }>;
}) {
  return (
    <section className="bg-card rounded-xl border shadow-sm">
      <div className="flex items-center justify-between border-b p-4">
        <h3 className="text-sm font-semibold">Последние операции</h3>
        <Link href="/finance/transactions" className="text-primary inline-flex items-center gap-1 text-sm hover:underline">
          Все операции <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="text-muted-foreground p-6 text-center text-sm">Операций пока нет</div>
      ) : (
        <div className="divide-y">
          {rows.map((r) => {
            const meta = CASH_TX_KIND_META[r.kind];
            const subtitle =
              r.kind === 'transfer'
                ? `${r.accountName ?? '—'} → ${r.counterAccountName ?? '—'}`
                : `${r.categoryName ?? 'Без статьи'} · ${r.accountName ?? '—'}`;
            return (
              <div key={r.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm">{r.comment || meta.label}</div>
                  <div className="text-muted-foreground truncate text-xs">{subtitle}</div>
                </div>
                <div className="text-right">
                  <div className={cn('text-sm font-semibold tabular-nums', meta.cls)}>
                    {meta.sign}
                    {formatRub(r.amountKopecks)}
                  </div>
                  <div className="text-muted-foreground text-xs tabular-nums">
                    {new Date(r.occurredOn).toLocaleDateString('ru-RU')}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PeriodTabs({ value, onChange }: { value: Preset; onChange: (p: Preset) => void }) {
  const presets: Preset[] = ['today', 'week', 'month', 'quarter', 'year'];
  return (
    <div className="bg-secondary inline-flex rounded-md p-0.5 text-xs">
      {presets.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            'rounded px-2.5 py-1 font-medium transition',
            p === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {PRESET_LABEL[p]}
        </button>
      ))}
    </div>
  );
}
