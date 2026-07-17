/**
 * /finance — Обзор кассы: остатки по счетам, приход/расход/разница за период,
 * помесячная динамика, расходы по статьям, последние операции.
 * RBAC: staff (директор + диспетчер). Графики — самописные (библиотеки нет).
 */
import { useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  CreditCard,
  Landmark,
  Minus,
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
import { CashInternalOpModal } from '../components/finance/CashInternalOpModal';
import { CASH_TX_KIND_META } from '../lib/dictionaries';

type Preset = 'today' | 'week' | 'month' | 'quarter' | 'year';
const PRESET_LABEL: Record<Preset, string> = {
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
  quarter: 'Квартал',
  year: 'Год',
};

/** С чем сравниваем. Сервер отдаёт тот же отрезок предыдущего периода (1–15 июля ↔ 1–15 июня). */
const PRESET_COMPARE_LABEL: Record<Preset, string> = {
  today: 'ко вчера',
  week: 'к прошлой неделе',
  month: 'к прошлому месяцу',
  quarter: 'к прошлому кварталу',
  year: 'к прошлому году',
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
  const [internalOpen, setInternalOpen] = useState(false);
  const [includeInternal, setIncludeInternal] = useState(false);
  const q = trpc.cash.overview.useQuery({ preset, includeInternal });
  const data = q.data;

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <FinanceTabs />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">Касса</h1>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodTabs value={preset} onChange={setPreset} />
          <button
            type="button"
            onClick={() => setInternalOpen(true)}
            className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition"
            title="Внесение в кассу / выдача из кассы — внутренняя операция, не доход и не расход бизнеса"
          >
            Внесение/выдача
          </button>
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
        <div className="text-muted-foreground bg-card rounded-lg border p-6 text-sm">
          Загружаем…
        </div>
      )}
      {q.error && (
        <div className="text-destructive bg-destructive/10 border-destructive/30 rounded-lg border p-4 text-sm">
          Не удалось загрузить: {q.error.message}
        </div>
      )}

      {data && (
        <>
          {/* Сводка за период: Собрано / Расход / Разница — главный вопрос «сколько сегодня?» */}
          <PeriodSummaryCard
            label={PRESET_LABEL[preset].toLowerCase()}
            compareLabel={PRESET_COMPARE_LABEL[preset]}
            summary={data.summary}
            previous={data.previous}
            includeInternal={includeInternal}
            onIncludeInternalChange={setIncludeInternal}
          />

          {/* Остатки по счетам — одна полоса вместо ряда крупных карточек */}
          <BalancesStrip balances={data.balances} />

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
      <CashInternalOpModal open={internalOpen} onClose={() => setInternalOpen(false)} />
    </div>
  );
}

/* ─────────────────────── дельта к прошлому периоду ─────────────────────── */

/**
 * Строчка «↑ 12% к прошлому месяцу» под цифрой.
 *
 * goodWhen: для прихода и разницы рост — это хорошо (зелёный), для расхода — плохо (красный).
 * Если в прошлом периоде был ноль — проценты считать не от чего, показываем сумму разницы.
 */
function Delta({
  current,
  previous,
  label,
  goodWhen,
}: {
  current?: string;
  previous?: string;
  label: string;
  goodWhen: 'up' | 'down';
}) {
  const cur = safeBig(current);
  const prev = safeBig(previous);
  // Сравнивать нечего — не мозолим глаза пустой строкой.
  if (cur === 0n && prev === 0n) return null;

  const diff = cur - prev;
  const hint = `Было ${formatRubWhole(prev.toString())} ${label}`;

  if (diff === 0n) {
    return (
      <div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs" title={hint}>
        <Minus className="h-3 w-3" />
        без изменений {label}
      </div>
    );
  }

  const up = diff > 0n;
  const good = goodWhen === 'up' ? up : !up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const absDiff = diff < 0n ? -diff : diff;
  const absPrev = prev < 0n ? -prev : prev;
  // Проценты в десятых долях, чтобы не терять точность на bigint.
  const text =
    absPrev === 0n
      ? formatRubWhole(absDiff.toString())
      : `${(Number((absDiff * 1000n) / absPrev) / 10).toLocaleString('ru-RU', {
          maximumFractionDigits: 1,
        })}%`;

  return (
    <div
      className={cn(
        'mt-1 flex items-center gap-1 text-xs font-medium',
        good ? 'text-success' : 'text-destructive',
      )}
      title={hint}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {text} {label}
    </div>
  );
}

/* ─────────────────── сводка за период (одна карточка) ─────────────────── */

interface OverviewSummary {
  incomeKopecks: string;
  expenseKopecks: string;
  profitKopecks: string;
  incomeByKind?: { cashKopecks?: string; cardKopecks?: string; bankKopecks?: string } | null;
  expenseByCategory: Array<{
    categoryId: string | null;
    categoryName: string;
    amountKopecks: string;
  }>;
}

function PeriodSummaryCard({
  label,
  compareLabel,
  summary,
  previous,
  includeInternal,
  onIncludeInternalChange,
}: {
  label: string;
  compareLabel: string;
  summary: OverviewSummary;
  previous?: { incomeKopecks: string; expenseKopecks: string; profitKopecks: string } | null;
  includeInternal: boolean;
  onIncludeInternalChange: (v: boolean) => void;
}) {
  // byKind может отсутствовать (старый бэкенд / рассинхрон версий) — не должно ронять страницу.
  const k = summary.incomeByKind ?? {};
  const profitPositive = safeBig(summary.profitKopecks) >= 0n;

  return (
    <section className="bg-card rounded-xl border shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2">
        <h3 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          За период · {label}
        </h3>
        {/* Тумблер внутренних операций: по умолчанию внесения/выдачи НЕ считаются доходом/расходом */}
        <label
          className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer select-none items-center gap-1.5 text-xs transition"
          title="Внесения в кассу и выдачи из неё — внутренние движения денег (обнал и т.п.). Выключено — в «Собрано», приходе и расходе их нет (нет двойного дохода). Включи, чтобы сверить цифры с реальным сейфом. На остатки счетов не влияет — они всегда учитывают всё."
        >
          <input
            type="checkbox"
            checked={includeInternal}
            onChange={(e) => onIncludeInternalChange(e.target.checked)}
            className="accent-primary h-3.5 w-3.5"
          />
          Учитывать внесения/выдачи
        </label>
      </div>

      <div className="grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <SummaryCell
          icon={TrendingUp}
          title="Собрано"
          value={formatRubWhole(summary.incomeKopecks)}
          valueCls="text-success"
          delta={
            <Delta
              current={summary.incomeKopecks}
              previous={previous?.incomeKopecks}
              label={compareLabel}
              goodWhen="up"
            />
          }
          extra={
            <div className="text-muted-foreground mt-1.5 text-xs tabular-nums">
              Нал {formatRubWhole(k.cashKopecks ?? '0')} · Карта{' '}
              {formatRubWhole(k.cardKopecks ?? '0')} · Безнал {formatRubWhole(k.bankKopecks ?? '0')}
            </div>
          }
        />
        <SummaryCell
          icon={TrendingDown}
          title="Расход"
          value={formatRubWhole(summary.expenseKopecks)}
          valueCls="text-destructive"
          // Рост расхода — плохо, поэтому зелёным подсвечиваем снижение.
          delta={
            <Delta
              current={summary.expenseKopecks}
              previous={previous?.expenseKopecks}
              label={compareLabel}
              goodWhen="down"
            />
          }
        />
        <SummaryCell
          icon={Scale}
          title="Разница (приход − расход)"
          value={formatRubWhole(summary.profitKopecks)}
          valueCls={profitPositive ? 'text-success' : 'text-destructive'}
          delta={
            <Delta
              current={summary.profitKopecks}
              previous={previous?.profitKopecks}
              label={compareLabel}
              goodWhen="up"
            />
          }
        />
      </div>
    </section>
  );
}

function SummaryCell({
  icon: Icon,
  title,
  value,
  valueCls,
  delta,
  extra,
}: {
  icon: typeof Wallet;
  title: string;
  value: string;
  valueCls: string;
  delta?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
        <Icon className={cn('h-3.5 w-3.5', valueCls)} />
        {title}
      </div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums tracking-tight', valueCls)}>
        {value}
      </div>
      {delta}
      {extra}
    </div>
  );
}

/* ─────────────────── остатки по счетам (одна полоса) ─────────────────── */

function BalancesStrip({
  balances,
}: {
  balances: {
    totalKopecks: string;
    cashKopecks: string;
    nonCashKopecks: string;
    accounts: Array<{
      id: string;
      name: string;
      kind: 'cash' | 'bank' | 'card';
      balanceKopecks: string;
    }>;
  };
}) {
  return (
    <section className="bg-card rounded-xl border p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary grid h-9 w-9 shrink-0 place-items-center rounded-lg">
            <Wallet className="h-4 w-4" />
          </span>
          <div>
            <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Всего денег
            </div>
            <div className="text-2xl font-semibold tabular-nums tracking-tight">
              {formatRubWhole(balances.totalKopecks)}
            </div>
          </div>
        </div>

        {balances.accounts.map((a) => {
          const Icon = ACCOUNT_ICON[a.kind] ?? Wallet;
          const neg = safeBig(a.balanceKopecks) < 0n;
          return (
            <div key={a.id} className="flex items-center gap-2.5">
              <span className="bg-secondary text-muted-foreground grid h-8 w-8 shrink-0 place-items-center rounded-lg">
                <Icon className="h-4 w-4" />
              </span>
              <div>
                <div className="text-muted-foreground text-xs">{a.name}</div>
                <div
                  className={cn(
                    'text-lg font-semibold tabular-nums leading-tight',
                    neg && 'text-destructive',
                  )}
                >
                  {formatRubWhole(a.balanceKopecks)}
                </div>
              </div>
            </div>
          );
        })}

        {balances.accounts.length === 0 && (
          <div className="text-muted-foreground text-sm">
            Счетов пока нет.{' '}
            <Link href="/finance/accounts" className="text-primary hover:underline">
              Завести счёт
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}

/* ───────────────────────────── графики ───────────────────────────── */

function MonthlyFlowCard({
  data,
}: {
  data: Array<{ month: string; incomeKopecks: string; expenseKopecks: string }>;
}) {
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
                  <div
                    className="bg-primary h-full rounded-full"
                    style={{ width: `${Math.max(pct, 2)}%` }}
                  />
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
        <Link
          href="/finance/transactions"
          className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
        >
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
            p === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {PRESET_LABEL[p]}
        </button>
      ))}
    </div>
  );
}
