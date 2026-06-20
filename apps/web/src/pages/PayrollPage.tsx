import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Loader2, Save, Settings as SettingsIcon, Wallet } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

type Period = 'today' | 'week' | 'month' | 'quarter';
type PayrollMode = 'piecework' | 'salary_bonus';

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

function rubToKopecksString(rubStr: string): string {
  const num = Number(rubStr.replace(/\s/g, '').replace(',', '.'));
  if (Number.isNaN(num) || num < 0) return '0';
  return Math.round(num * 100).toString();
}

export function PayrollPage() {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.user.role;

  if (role === 'engineer') return <EngineerEarnings />;
  return <DirectorPayroll />;
}

/* ========================== ДИРЕКТОР ========================== */

function DirectorPayroll() {
  const [period, setPeriod] = useState<Period>('month');
  const ruleQ = trpc.payroll.getRule.useQuery();
  const payoutsQ = trpc.payroll.computePayouts.useQuery({ preset: period });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold md:text-2xl">Зарплата инженеров</h2>
          <p className="text-muted-foreground text-sm">
            Расчёт по правилу{' '}
            <span className="text-foreground font-medium">
              {ruleQ.data?.mode === 'piecework' ? 'сделка' : 'оклад + бонус'}
            </span>
            {ruleQ.data && ruleQ.data.mode === 'piecework' && (
              <> · {ruleQ.data.pieceworkPercent}% от работ</>
            )}
            {ruleQ.data && ruleQ.data.mode === 'salary_bonus' && (
              <>
                {' '}
                · оклад {formatRubFromKopecks(ruleQ.data.baseSalaryKopecks)} +{' '}
                {ruleQ.data.bonusPercent}% от работ
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodTabs value={period} onChange={setPeriod} />
          <Link
            href="/settings/payroll"
            className="bg-secondary hover:bg-muted inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition"
          >
            <SettingsIcon className="h-4 w-4" />
            Правила
          </Link>
        </div>
      </div>

      {payoutsQ.isLoading && (
        <div className="bg-card flex items-center gap-3 rounded-lg border p-4">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">Считаем…</span>
        </div>
      )}

      {payoutsQ.error && (
        <div className="bg-destructive/10 text-destructive rounded-lg border border-destructive/30 p-4 text-sm">
          {payoutsQ.error.message}
        </div>
      )}

      {payoutsQ.data && (
        <>
          <div className="bg-card flex items-center justify-between rounded-lg border p-4">
            <div>
              <div className="text-muted-foreground text-xs uppercase">Итого к выплате</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums">
                {formatRubFromKopecks(payoutsQ.data.grandTotalKopecks)}
              </div>
              <div className="text-muted-foreground mt-1 text-xs">
                {PERIOD_LABEL[period]} · {payoutsQ.data.rows.length} инженер(ов)
              </div>
            </div>
            <Wallet className="text-muted-foreground h-8 w-8" />
          </div>

          <div className="bg-card overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase">
                <tr>
                  <th className="p-3 text-left font-medium">Инженер</th>
                  <th className="p-3 text-right font-medium">Закрыто нарядов</th>
                  <th className="p-3 text-right font-medium">Сумма работ</th>
                  <th className="p-3 text-right font-medium">Оклад</th>
                  <th className="p-3 text-right font-medium">Сделка/бонус</th>
                  <th className="p-3 text-right font-medium">К выплате</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {payoutsQ.data.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-muted-foreground p-6 text-center">
                      За выбранный период работ нет
                    </td>
                  </tr>
                )}
                {payoutsQ.data.rows.map((r) => (
                  <tr key={r.engineerId} className="hover:bg-muted/30">
                    <td className="p-3 font-medium">{r.engineerName}</td>
                    <td className="p-3 text-right tabular-nums">{r.closedOrdersCount}</td>
                    <td className="p-3 text-right tabular-nums">
                      {formatRubFromKopecks(r.worksAmountKopecks)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {formatRubFromKopecks(r.baseSalaryKopecks)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {formatRubFromKopecks(r.pieceworkPartKopecks)}
                    </td>
                    <td className="text-success p-3 text-right text-base font-semibold tabular-nums">
                      {formatRubFromKopecks(r.totalEarningsKopecks)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ========================== ИНЖЕНЕР ========================== */

function EngineerEarnings() {
  const [period, setPeriod] = useState<Period>('month');
  const myEarningsQ = trpc.payroll.myEarnings.useQuery({ preset: period });

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold">Мой заработок</h2>
          <p className="text-muted-foreground text-sm">
            На основе закрытых нарядов в периоде
          </p>
        </div>
        <PeriodTabs value={period} onChange={setPeriod} />
      </div>

      {myEarningsQ.isLoading && (
        <div className="bg-card flex items-center gap-3 rounded-lg border p-4">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">Считаем…</span>
        </div>
      )}

      {myEarningsQ.data && (
        <div className="space-y-4">
          <div className="bg-card rounded-lg border p-6">
            <div className="text-muted-foreground text-xs uppercase">К выплате</div>
            <div className="text-success mt-1 text-4xl font-semibold tabular-nums">
              {formatRubFromKopecks(myEarningsQ.data.grandTotalKopecks)}
            </div>
            <div className="text-muted-foreground mt-2 text-sm">
              {PERIOD_LABEL[period]} ·{' '}
              {myEarningsQ.data.rule.mode === 'piecework'
                ? `${myEarningsQ.data.rule.pieceworkPercent}% сделка`
                : `оклад + ${myEarningsQ.data.rule.bonusPercent}% бонус`}
            </div>
          </div>

          {myEarningsQ.data.rows[0] && (
            <div className="bg-card grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm">
              <div>
                <div className="text-muted-foreground text-xs uppercase">Закрыто нарядов</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {myEarningsQ.data.rows[0].closedOrdersCount}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs uppercase">Сумма работ</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatRubFromKopecks(myEarningsQ.data.rows[0].worksAmountKopecks)}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ========================== НАСТРОЙКИ ПРАВИЛ ========================== */

export function PayrollSettingsPage() {
  const utils = trpc.useUtils();
  const ruleQ = trpc.payroll.getRule.useQuery();
  const usersQ = trpc.users.list.useQuery({ onlyEngineers: true });

  const setRuleM = trpc.payroll.setRule.useMutation({
    onSuccess: () => utils.payroll.getRule.invalidate(),
  });
  const setRateM = trpc.users.setHourlyCostRate.useMutation({
    onSuccess: () => utils.users.list.invalidate(),
  });

  const [mode, setMode] = useState<PayrollMode>('piecework');
  const [pieceworkPercent, setPieceworkPercent] = useState('30');
  const [baseSalaryRub, setBaseSalaryRub] = useState('0');
  const [bonusPercent, setBonusPercent] = useState('0');
  const [hydrated, setHydrated] = useState(false);

  // Подгружаем актуальные значения правила в форму ОДИН раз, когда оно загрузилось.
  // ВАЖНО: только через useEffect. setState прямо в теле рендера (как было раньше)
  // при некоторых сохранённых значениях правила давал бесконечный цикл ре-рендеров
  // («Too many re-renders») → белый экран на /settings/payroll.
  useEffect(() => {
    if (!ruleQ.data || hydrated) return;
    setMode(ruleQ.data.mode);
    setPieceworkPercent(String(ruleQ.data.pieceworkPercent));
    setBaseSalaryRub((Number(ruleQ.data.baseSalaryKopecks) / 100).toString());
    setBonusPercent(String(ruleQ.data.bonusPercent));
    setHydrated(true);
  }, [ruleQ.data, hydrated]);

  const submitRule = () => {
    setRuleM.mutate({
      mode,
      pieceworkPercent: Number(pieceworkPercent) || 0,
      baseSalaryKopecks: rubToKopecksString(baseSalaryRub),
      bonusPercent: Number(bonusPercent) || 0,
    });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <div>
        <Link href="/payroll" className="text-primary text-sm hover:underline">
          ← Зарплата
        </Link>
        <h2 className="mt-2 text-xl font-semibold md:text-2xl">Правила расчёта ЗП</h2>
        <p className="text-muted-foreground text-sm">
          Действует для всех инженеров. Расчёт on-the-fly по закрытым нарядам.
        </p>
      </div>

      <section className="bg-card space-y-4 rounded-lg border p-5">
        <div>
          <label className="text-sm font-medium">Режим расчёта</label>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ModeOption
              checked={mode === 'piecework'}
              onClick={() => setMode('piecework')}
              title="Сделка"
              description="Только % от стоимости работ"
            />
            <ModeOption
              checked={mode === 'salary_bonus'}
              onClick={() => setMode('salary_bonus')}
              title="Оклад + бонус"
              description="Фикс. оклад + % от работ"
            />
          </div>
        </div>

        {mode === 'piecework' && (
          <div>
            <label className="text-sm font-medium">Процент сделки (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={pieceworkPercent}
              onChange={(e) => setPieceworkPercent(e.target.value)}
              className="border-input bg-background mt-1 block w-32 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        )}

        {mode === 'salary_bonus' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">Оклад, ₽</label>
              <input
                type="text"
                inputMode="decimal"
                value={baseSalaryRub}
                onChange={(e) => setBaseSalaryRub(e.target.value)}
                className="border-input bg-background mt-1 block w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Бонус (% от работ)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={bonusPercent}
                onChange={(e) => setBonusPercent(e.target.value)}
                className="border-input bg-background mt-1 block w-32 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={submitRule}
            disabled={setRuleM.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-60"
          >
            {setRuleM.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Сохранить правило
          </button>
          {setRuleM.isSuccess && (
            <span className="text-success text-xs">Сохранено</span>
          )}
        </div>
      </section>

      <section className="bg-card rounded-lg border">
        <div className="border-b p-4">
          <h3 className="font-semibold">Внутренняя ставка инженеров (₽/час)</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Используется для расчёта себестоимости работ (cost). На ЗП напрямую не влияет.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase">
            <tr>
              <th className="p-3 text-left font-medium">Инженер</th>
              <th className="p-3 text-left font-medium">Логин</th>
              <th className="p-3 text-right font-medium">Ставка, ₽/ч</th>
              <th className="p-3 text-right font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {usersQ.data?.length === 0 && (
              <tr>
                <td colSpan={4} className="text-muted-foreground p-6 text-center">
                  Инженеры не заведены
                </td>
              </tr>
            )}
            {usersQ.data?.map((u) => (
              <UserRateRow
                key={u.id}
                userId={u.id}
                fullName={u.fullName}
                username={u.username}
                rateKopecks={u.hourlyCostRateKopecks}
                onSave={(rateRub) =>
                  setRateM.mutateAsync({
                    userId: u.id,
                    rateKopecks: rubToKopecksString(rateRub),
                  })
                }
                isSaving={setRateM.isPending && setRateM.variables?.userId === u.id}
              />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ModeOption({
  checked,
  onClick,
  title,
  description,
}: {
  checked: boolean;
  onClick: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border p-3 text-left transition',
        checked
          ? 'border-primary bg-primary/5'
          : 'border-input hover:border-primary/40',
      )}
    >
      <div className="font-medium">{title}</div>
      <div className="text-muted-foreground text-xs">{description}</div>
    </button>
  );
}

function UserRateRow({
  userId,
  fullName,
  username,
  rateKopecks,
  onSave,
  isSaving,
}: {
  userId: string;
  fullName: string;
  username: string;
  rateKopecks: string;
  onSave: (rateRub: string) => Promise<unknown>;
  isSaving: boolean;
}) {
  const initialRub = (Number(rateKopecks) / 100).toString();
  const [val, setVal] = useState(initialRub);
  const dirty = val !== initialRub;
  return (
    <tr className="hover:bg-muted/30">
      <td className="p-3 font-medium">{fullName}</td>
      <td className="text-muted-foreground p-3 font-mono text-xs">{username}</td>
      <td className="p-3 text-right">
        <input
          type="text"
          inputMode="decimal"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="border-input bg-background w-28 rounded-md border px-2 py-1 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40"
          data-userid={userId}
        />
      </td>
      <td className="p-3 text-right">
        <button
          type="button"
          disabled={!dirty || isSaving}
          onClick={() => void onSave(val)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition disabled:opacity-50"
        >
          {isSaving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Save className="h-3 w-3" />
          )}
          Сохранить
        </button>
      </td>
    </tr>
  );
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
