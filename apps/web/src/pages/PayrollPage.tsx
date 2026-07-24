import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  Calculator,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Plus,
  Save,
  Settings as SettingsIcon,
  Trash2,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { SILENT_ERROR } from '../lib/error-message';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

type Period = 'today' | 'week' | 'month' | 'quarter';
type PayrollMode = 'piecework' | 'salary_bonus';

function parseRubNumber(rubStr: string): number {
  const n = Number(rubStr.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

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
  return <PayrollVedomost />;
}

/* ========================== ИНЖЕНЕР ========================== */

function EngineerEarnings() {
  const [period, setPeriod] = useState<Period>('month');
  const myEarningsQ = trpc.payroll.myEarnings.useQuery({ preset: period });

  // Директор мог отключить показ — тогда сервер отдаёт { enabled: false } без сумм.
  const data = myEarningsQ.data?.enabled ? myEarningsQ.data : null;
  const disabled = myEarningsQ.data?.enabled === false;
  const row = data?.rows[0];
  const works = row ? BigInt(row.worksAmountKopecks) : 0n;
  const piece = row ? BigInt(row.pieceworkPartKopecks) : 0n;
  const base = row ? BigInt(row.baseSalaryKopecks) : 0n;
  // Эффективный % — из фактической суммы (уважает персональную ставку), не из глоб. правила.
  const effectivePercent =
    works > 0n && piece > 0n ? Math.round((Number(piece) / Number(works)) * 100) : null;

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

      {disabled && (
        <div className="bg-card text-muted-foreground rounded-lg border p-6 text-sm">
          Показ заработка сейчас отключён директором.
        </div>
      )}

      {data && (
        <div className="space-y-4">
          <div className="bg-card rounded-lg border p-6">
            <div className="text-muted-foreground text-xs uppercase">К выплате · {PERIOD_LABEL[period]}</div>
            <div className="text-success mt-1 text-4xl font-semibold tabular-nums">
              {formatRubFromKopecks(data.grandTotalKopecks)}
            </div>
          </div>

          {/* Проценты за ремонт — рублями (главная цифра для инженера) */}
          <div className="bg-primary/5 border-primary/20 rounded-lg border p-5">
            <div className="text-primary text-xs font-medium uppercase">Проценты за ремонт</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">
              {formatRubFromKopecks(piece.toString())}
            </div>
            <div className="text-muted-foreground mt-1 text-sm">
              {effectivePercent !== null
                ? `${effectivePercent}% от суммы работ ${formatRubFromKopecks(works.toString())}`
                : `от суммы работ ${formatRubFromKopecks(works.toString())}`}
            </div>
          </div>

          {base > 0n && (
            <div className="bg-card rounded-lg border p-5">
              <div className="text-muted-foreground text-xs uppercase">Оклад</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {formatRubFromKopecks(base.toString())}
              </div>
              <div className="text-muted-foreground mt-1 text-sm">
                начисляется помесячно
                {period !== 'month' && ' · показан за месяц целиком'}
              </div>
            </div>
          )}

          <div className="bg-card grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm">
            <div>
              <div className="text-muted-foreground text-xs uppercase">Закрыто нарядов</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {row?.closedOrdersCount ?? 0}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs uppercase">Сумма работ</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatRubFromKopecks(works.toString())}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ========================== НАСТРОЙКИ ПРАВИЛ ========================== */

export function PayrollSettingsPage() {
  const utils = trpc.useUtils();
  const ruleQ = trpc.payroll.getRule.useQuery();
  const staffQ = trpc.users.list.useQuery();

  const setRuleM = trpc.payroll.setRule.useMutation({
    onSuccess: () => utils.payroll.getRule.invalidate(),
  });
  const setUserPayoutM = trpc.users.setUserPayout.useMutation({
    onSuccess: () => utils.users.list.invalidate(),
  });
  const setSeeEarningsM = trpc.payroll.setEngineersSeeEarnings.useMutation({
    onSuccess: () => utils.payroll.getRule.invalidate(),
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
          Правило по умолчанию + персональная зарплата по каждому сотруднику ниже.
          Расчёт on-the-fly по закрытым нарядам.
        </p>
      </div>

      <section className="bg-card space-y-4 rounded-lg border p-5">
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Правило по умолчанию (для тех, кому не задана персональная зарплата ниже)
          </div>
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

      <section className="bg-card rounded-lg border p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold">Инженеры видят свой заработок в кабинете</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              Когда включено — инженер видит у себя (на телефоне и в полной версии) начисленные
              проценты за ремонт в рублях, оклад и сумму к выплате за период. Выключите, если не
              хотите показывать заработок инженерам — расчёт ЗП у директора при этом сохранится.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={ruleQ.data?.engineersSeeEarnings ?? true}
            aria-label="Показывать инженерам их заработок"
            disabled={ruleQ.isLoading || setSeeEarningsM.isPending}
            onClick={() =>
              setSeeEarningsM.mutate({ enabled: !(ruleQ.data?.engineersSeeEarnings ?? true) })
            }
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50',
              (ruleQ.data?.engineersSeeEarnings ?? true) ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
          >
            <span
              className={cn(
                'bg-background inline-block h-5 w-5 transform rounded-full shadow transition',
                (ruleQ.data?.engineersSeeEarnings ?? true) ? 'translate-x-[22px]' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
      </section>

      <section className="bg-card rounded-lg border">
        <div className="border-b p-4">
          <h3 className="font-semibold">Зарплата по сотрудникам (оклад + бонус)</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            У каждого — свой оклад (₽/мес) и бонус % от выполненных работ. Пусто в обеих
            ячейках — действует правило по умолчанию выше.
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            Этот же процент идёт в себестоимость работ: в отчёте «Рентабельность» работа
            инженера считается по нему. Оклад в себестоимость заявки не входит — он
            постоянный расход и виден в кассе.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="p-3 text-left font-medium">Сотрудник</th>
                <th className="p-3 text-left font-medium">Роль</th>
                <th className="p-3 text-right font-medium">Оклад, ₽/мес</th>
                <th className="p-3 text-right font-medium">Бонус, %</th>
                <th className="p-3 text-right font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {staffQ.data?.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted-foreground p-6 text-center">
                    Сотрудники не заведены
                  </td>
                </tr>
              )}
              {staffQ.data?.map((u) => (
                <UserPayoutRow
                  key={u.id}
                  fullName={u.fullName}
                  role={u.role}
                  baseSalaryKopecks={u.payoutBaseSalaryKopecks}
                  bonusPercent={u.payoutBonusPercent}
                  onSave={(baseKopecks, bonus) =>
                    setUserPayoutM.mutateAsync({
                      userId: u.id,
                      baseSalaryKopecks: baseKopecks,
                      bonusPercent: bonus,
                    })
                  }
                  isSaving={setUserPayoutM.isPending && setUserPayoutM.variables?.userId === u.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/*
        Раздел «Внутренняя ставка инженеров (₽/час)» убран: себестоимость работы теперь
        считается процентом инженера от цены работы, а не ставкой за час. Причина — работу
        в нарядах пишут в «шт», а не в «час», поэтому ставка приравнивала 15-минутную
        работу к трёхдневной. Поле осталось в базе, но ни на что не влияет — держать
        в интерфейсе орган управления, который ничего не меняет, нельзя.
      */}
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

const ROLE_RU: Record<'director' | 'dispatcher' | 'engineer', string> = {
  director: 'Директор',
  dispatcher: 'Диспетчер',
  engineer: 'Инженер',
};

function UserPayoutRow({
  fullName,
  role,
  baseSalaryKopecks,
  bonusPercent,
  onSave,
  isSaving,
}: {
  fullName: string;
  role: 'director' | 'dispatcher' | 'engineer';
  baseSalaryKopecks: string | null;
  bonusPercent: number | null;
  onSave: (baseKopecks: string | null, bonus: number | null) => Promise<unknown>;
  isSaving: boolean;
}) {
  const initialSalary = baseSalaryKopecks !== null ? (Number(baseSalaryKopecks) / 100).toString() : '';
  const initialBonus = bonusPercent !== null ? String(bonusPercent) : '';
  const [salary, setSalary] = useState(initialSalary);
  const [bonus, setBonus] = useState(initialBonus);
  const dirty = salary !== initialSalary || bonus !== initialBonus;
  const usesDefault = initialSalary === '' && initialBonus === '';

  const save = () => {
    const baseNum = parseRubNumber(salary); // 0 при пусто/мусоре/отрицательном
    const bonusNum = Math.max(0, Math.min(100, Math.round(Number(bonus) || 0)));
    const hasBase = baseNum > 0;
    const hasBonus = bonus.trim() !== '' && bonusNum > 0;
    // Обе ячейки пусты/нулевые → вернуть сотрудника на правило по умолчанию,
    // а НЕ обнулять его ЗП (иначе ввод «0» молча снимал бы с глобальной сделки).
    if (!hasBase && !hasBonus) {
      void onSave(null, null);
      return;
    }
    void onSave(hasBase ? rubToKopecksString(salary) : '0', bonusNum);
  };

  return (
    <tr className="hover:bg-muted/30">
      <td className="p-3 font-medium">
        {fullName}
        {usesDefault && (
          <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-[10px] align-middle">
            по умолчанию
          </span>
        )}
      </td>
      <td className="text-muted-foreground p-3 text-xs">{ROLE_RU[role]}</td>
      <td className="p-3 text-right">
        <input
          type="text"
          inputMode="decimal"
          placeholder="—"
          value={salary}
          onChange={(e) => setSalary(e.target.value)}
          className="border-input bg-background w-28 rounded-md border px-2 py-1 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </td>
      <td className="p-3 text-right">
        <input
          type="number"
          min={0}
          max={100}
          placeholder="—"
          value={bonus}
          onChange={(e) => setBonus(e.target.value)}
          className="border-input bg-background w-20 rounded-md border px-2 py-1 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </td>
      <td className="p-3 text-right">
        <button
          type="button"
          disabled={!dirty || isSaving}
          onClick={save}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition disabled:opacity-50"
        >
          {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
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

/* ===================== Ведомость — единственный экран ЗП директора ===================== */

const MONTHS_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const MONTHS_SHORT = [
  'Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
  'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек',
];

function kopToRubInput(kopecks: number): string {
  return kopecks ? String(kopecks / 100) : '';
}
function kopStr(rub: number): string {
  return String(Math.round(rub * 100));
}

type VedRow = {
  employeeId: string;
  employeeName: string;
  /** Сделка (₽) — автозаполняется по % от работ, редактируется руками. */
  piecework: string;
  salary: string;
  advance: string;
  bonus: string;
};

function PayrollVedomost() {
  const utils = trpc.useUtils();
  const sheetsQ = trpc.payroll.sheets.list.useQuery();
  const staffQ = trpc.users.list.useQuery();
  const ruleQ = trpc.payroll.getRule.useQuery();
  const accountsQ = trpc.cash.accounts.list.useQuery();
  const accounts: Array<{ id: string; name: string }> = accountsQ.data ?? [];

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [monthIdx, setMonthIdx] = useState(now.getMonth()); // 0-based
  const monthKey = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
  const monthStartIso = new Date(Date.UTC(year, monthIdx, 1)).toISOString();
  const monthEndIso = new Date(Date.UTC(year, monthIdx + 1, 1)).toISOString();

  // Работы по каждому за выбранный месяц — переиспользуем расчёт по закрытым нарядам.
  const worksQ = trpc.payroll.computePayouts.useQuery({
    preset: 'custom',
    start: monthStartIso,
    end: monthEndIso,
  });
  const worksByEmployee = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of worksQ.data?.rows ?? []) {
      m.set(r.engineerId, Number(r.worksAmountKopecks));
    }
    return m;
  }, [worksQ.data]);

  const saveM = trpc.payroll.sheets.save.useMutation({
    onSuccess: () => utils.payroll.sheets.list.invalidate(),
  });
  const deleteM = trpc.payroll.sheets.delete.useMutation({
    meta: SILENT_ERROR,
    onSuccess: () => utils.payroll.sheets.list.invalidate(),
  });
  const afterCash = () => {
    void utils.payroll.sheets.list.invalidate();
    void utils.cash.invalidate();
  };
  const postM = trpc.payroll.sheets.postToCash.useMutation({ onSuccess: afterCash });
  const unpostM = trpc.payroll.sheets.unpost.useMutation({ onSuccess: afterCash });

  const savedSheet = useMemo(
    () => sheetsQ.data?.find((s) => s.month === monthKey) ?? null,
    [sheetsQ.data, monthKey],
  );

  const [rows, setRows] = useState<VedRow[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // % от работ — по умолчанию из глобального правила (процент сделки).
  const [percent, setPercent] = useState('');
  useEffect(() => {
    if (percent === '' && ruleQ.data) setPercent(String(ruleQ.data.pieceworkPercent ?? 0));
  }, [ruleQ.data, percent]);

  // Гидрируем строки из сохранённой ведомости при смене месяца / первой загрузке.
  useEffect(() => {
    if (!sheetsQ.data) return;
    if (loadedKey === monthKey) return;
    setRows(
      savedSheet
        ? savedSheet.entries.map((e) => ({
            employeeId: e.employeeId,
            employeeName: e.employeeName,
            piecework: kopToRubInput(e.pieceworkKopecks ?? 0),
            salary: kopToRubInput(e.salaryKopecks),
            advance: kopToRubInput(e.advanceKopecks),
            bonus: kopToRubInput(e.bonusKopecks),
          }))
        : [],
    );
    setLoadedKey(monthKey);
  }, [sheetsQ.data, savedSheet, monthKey, loadedKey]);

  const prevMonth = () => {
    setLoadedKey(null);
    if (monthIdx === 0) {
      setMonthIdx(11);
      setYear((y) => y - 1);
    } else setMonthIdx((m) => m - 1);
  };
  const nextMonth = () => {
    setLoadedKey(null);
    if (monthIdx === 11) {
      setMonthIdx(0);
      setYear((y) => y + 1);
    } else setMonthIdx((m) => m + 1);
  };

  const pullEmployees = () => {
    const present = new Set(rows.map((r) => r.employeeId));
    const additions: VedRow[] = (staffQ.data ?? [])
      .filter((u) => !present.has(u.id))
      .map((u) => ({
        employeeId: u.id,
        employeeName: u.fullName,
        piecework: '',
        salary: '',
        advance: '',
        bonus: '',
      }));
    if (additions.length > 0) setRows((prev) => [...prev, ...additions]);
  };

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      {
        employeeId: `manual_${prev.length}_${monthKey}`,
        employeeName: '',
        piecework: '',
        salary: '',
        advance: '',
        bonus: '',
      },
    ]);
  const removeRow = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx));
  const setField = (idx: number, field: keyof VedRow, value: string) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));

  // «Посчитать по %» — каждому подставляем его работы за месяц × процент в колонку «Сделка».
  // Ручные строки и тех, у кого работ нет, не трогаем.
  const applyPercent = () => {
    const p = Math.max(0, Number(percent.replace(',', '.')) || 0);
    setRows((prev) =>
      prev.map((r) => {
        const worksKop = worksByEmployee.get(r.employeeId);
        if (worksKop === undefined) return r;
        const pieceRub = Math.round((worksKop * p) / 100) / 100;
        return { ...r, piecework: pieceRub ? String(pieceRub) : '' };
      }),
    );
  };

  const totals = useMemo(() => {
    let piecework = 0;
    let salary = 0;
    let advance = 0;
    let bonus = 0;
    for (const r of rows) {
      piecework += parseRubNumber(r.piecework);
      salary += parseRubNumber(r.salary);
      advance += parseRubNumber(r.advance);
      bonus += parseRubNumber(r.bonus);
    }
    return { piecework, salary, advance, bonus, total: piecework + salary + advance + bonus };
  }, [rows]);

  const buildEntries = () =>
    rows.map((r) => ({
      employeeId: r.employeeId,
      employeeName: r.employeeName.trim(),
      pieceworkRub: parseRubNumber(r.piecework),
      salaryRub: parseRubNumber(r.salary),
      advanceRub: parseRubNumber(r.advance),
      bonusRub: parseRubNumber(r.bonus),
    }));

  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const doSave = (withReason?: string) => {
    saveM.mutate(
      { month: monthKey, entries: buildEntries(), reason: withReason },
      {
        onSuccess: () => {
          setReasonOpen(false);
          setReason('');
        },
      },
    );
  };
  const handleSave = () => {
    if (savedSheet) setReasonOpen(true);
    else doSave();
  };
  const handleDelete = () => {
    deleteM.mutate(
      { month: monthKey },
      {
        onSuccess: () => {
          setConfirmDelete(false);
          setRows([]);
          setLoadedKey(null);
        },
      },
    );
  };

  // ── Проведение в кассу ──
  const posted = savedSheet?.cashTransactionId != null;
  const postedAmount = savedSheet?.postedAmountKopecks ?? null;
  const savedTotalKop = useMemo(() => {
    if (!savedSheet) return 0;
    return savedSheet.entries.reduce(
      (s, e) => s + e.salaryKopecks + (e.pieceworkKopecks ?? 0) + e.advanceKopecks + e.bonusKopecks,
      0,
    );
  }, [savedSheet]);
  const needsRepost = posted && postedAmount != null && String(savedTotalKop) !== postedAmount;

  const [postOpen, setPostOpen] = useState(false);
  const [postAccountId, setPostAccountId] = useState('');
  const openPost = () => {
    setPostAccountId(savedSheet?.postedAccountId ?? accounts[0]?.id ?? '');
    setPostOpen(true);
  };
  const doPost = () => {
    if (!postAccountId) return;
    postM.mutate({ month: monthKey, accountId: postAccountId }, { onSuccess: () => setPostOpen(false) });
  };

  // ── Годовая сводка ──
  const [summaryYear, setSummaryYear] = useState(now.getFullYear());
  const summary = useMemo(() => {
    const map = new Map<string, { name: string; months: number[] }>();
    for (const s of sheetsQ.data ?? []) {
      if (!s.month.startsWith(`${summaryYear}-`)) continue;
      const mIdx = Number(s.month.slice(5, 7)) - 1;
      if (mIdx < 0 || mIdx > 11) continue;
      for (const e of s.entries) {
        const kop =
          e.salaryKopecks + (e.pieceworkKopecks ?? 0) + e.advanceKopecks + e.bonusKopecks;
        let rec = map.get(e.employeeId);
        if (!rec) {
          rec = { name: e.employeeName, months: Array.from({ length: 12 }, () => 0) };
          map.set(e.employeeId, rec);
        }
        if (e.employeeName) rec.name = e.employeeName;
        rec.months[mIdx] = (rec.months[mIdx] ?? 0) + kop;
      }
    }
    return Array.from(map.entries())
      .map(([id, rec]) => ({
        id,
        name: rec.name,
        months: rec.months,
        yearTotal: rec.months.reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.yearTotal - a.yearTotal);
  }, [sheetsQ.data, summaryYear]);

  const exportSummary = () => {
    const header = ['Сотрудник', ...MONTHS_SHORT, 'Итого за год'];
    const lines = [header.join('\t')];
    for (const r of summary) {
      lines.push(
        [r.name, ...r.months.map((k) => Math.round(k / 100)), Math.round(r.yearTotal / 100)].join(
          '\t',
        ),
      );
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vedomost_${summaryYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const numCls =
    'border-input bg-background w-24 rounded-md border px-2 py-1 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold md:text-2xl">Зарплата — ведомость</h2>
          <p className="text-muted-foreground text-sm">
            Помесячно. «Сделка» считается процентом от закрытых заявок — любую сумму можно поправить
            руками для справедливости.
          </p>
        </div>
        <Link
          href="/settings/payroll"
          className="bg-secondary hover:bg-muted inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition"
        >
          <SettingsIcon className="h-4 w-4" />
          Правила
        </Link>
      </div>

      {/* ── Ведомость за месяц ── */}
      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="bg-secondary text-muted-foreground flex items-center gap-1 rounded-md p-0.5">
              <button
                type="button"
                onClick={prevMonth}
                className="hover:bg-background rounded p-1 transition"
                aria-label="Предыдущий месяц"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-foreground min-w-[132px] text-center text-sm font-medium">
                {MONTHS_RU[monthIdx]} {year}
              </span>
              <button
                type="button"
                onClick={nextMonth}
                className="hover:bg-background rounded p-1 transition"
                aria-label="Следующий месяц"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-xs">% от работ</span>
              <input
                type="text"
                inputMode="decimal"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                className="border-input bg-background w-14 rounded-md border px-2 py-1 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                type="button"
                onClick={applyPercent}
                className="bg-secondary hover:bg-muted inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium transition"
              >
                <Calculator className="h-4 w-4" />
                Посчитать
              </button>
            </div>
            {savedSheet && (
              <span className="text-muted-foreground text-xs">
                Сохранено: {new Date(savedSheet.savedAt).toLocaleString('ru-RU')}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={pullEmployees}
              className="bg-secondary hover:bg-muted inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
            >
              <Users className="h-4 w-4" />
              Подтянуть сотрудников
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saveM.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-60"
            >
              {saveM.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Сохранить
            </button>
            {savedSheet && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-destructive border-destructive/30 hover:bg-destructive/10 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-medium transition"
                aria-label="Удалить ведомость за месяц"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {saveM.error && !reasonOpen && (
          <div className="bg-destructive/10 text-destructive border-b border-destructive/30 p-3 text-sm">
            {saveM.error.message}
          </div>
        )}

        {/* Проведение в кассу */}
        {savedSheet && (
          <div className="bg-muted/20 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 text-sm">
            {posted ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-success inline-flex items-center gap-1 font-medium">
                  <Check className="h-4 w-4" />
                  Проведено в кассу: {formatRubFromKopecks(postedAmount ?? '0')}
                </span>
                {needsRepost && (
                  <span className="text-warning text-xs">
                    ведомость изменилась ({formatRubFromKopecks(String(savedTotalKop))}) —
                    перепроведите
                  </span>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">
                Не проведено в кассу — общие деньги (касса/ДДС) не затронуты.
                {accounts.length === 0 && ' Заведите денежный счёт в «Финансах».'}
              </span>
            )}
            <div className="flex items-center gap-2">
              {(!posted || needsRepost) && (
                <button
                  type="button"
                  onClick={openPost}
                  disabled={accounts.length === 0 || postM.isPending}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
                >
                  {postM.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wallet className="h-4 w-4" />
                  )}
                  {posted ? 'Перепровести' : 'Провести в кассу'}
                </button>
              )}
              {posted && (
                <button
                  type="button"
                  onClick={() => unpostM.mutate({ month: monthKey })}
                  disabled={unpostM.isPending}
                  className="border-input hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
                >
                  {unpostM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Отменить проведение
                </button>
              )}
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="p-3 text-left font-medium" style={{ minWidth: 170 }}>
                  Сотрудник
                </th>
                <th className="p-3 text-right font-medium">Работы за месяц</th>
                <th className="p-3 text-right font-medium">Сделка, ₽</th>
                <th className="p-3 text-right font-medium">Оклад, ₽</th>
                <th className="p-3 text-right font-medium">Аванс, ₽</th>
                <th className="p-3 text-right font-medium">Премия, ₽</th>
                <th className="p-3 text-right font-medium">Итого</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-muted-foreground p-6 text-center">
                    Нажмите «Подтянуть сотрудников» или добавьте строку вручную
                  </td>
                </tr>
              ) : (
                rows.map((r, idx) => {
                  const worksKop = worksByEmployee.get(r.employeeId);
                  const rowTotal =
                    parseRubNumber(r.piecework) +
                    parseRubNumber(r.salary) +
                    parseRubNumber(r.advance) +
                    parseRubNumber(r.bonus);
                  return (
                    <tr key={`${r.employeeId}-${idx}`} className="hover:bg-muted/30">
                      <td className="p-2">
                        <input
                          type="text"
                          value={r.employeeName}
                          onChange={(e) => setField(idx, 'employeeName', e.target.value)}
                          placeholder="Имя сотрудника"
                          className="border-input bg-background w-full rounded-md border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                        />
                      </td>
                      <td className="text-muted-foreground p-3 text-right tabular-nums whitespace-nowrap">
                        {worksKop === undefined ? '—' : formatRubFromKopecks(String(worksKop))}
                      </td>
                      {(['piecework', 'salary', 'advance', 'bonus'] as const).map((field) => (
                        <td key={field} className="p-2 text-right">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={r[field]}
                            onChange={(e) => setField(idx, field, e.target.value)}
                            placeholder="0"
                            className={numCls}
                          />
                        </td>
                      ))}
                      <td className="p-3 text-right font-semibold tabular-nums whitespace-nowrap">
                        {formatRubFromKopecks(kopStr(rowTotal))}
                      </td>
                      <td className="p-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeRow(idx)}
                          className="text-muted-foreground hover:text-destructive p-1 transition"
                          aria-label="Удалить строку"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="bg-muted/40 border-t-2 font-semibold tabular-nums">
                  <td className="p-3">Всего</td>
                  <td className="text-muted-foreground p-3 text-right">—</td>
                  <td className="p-3 text-right">{formatRubFromKopecks(kopStr(totals.piecework))}</td>
                  <td className="p-3 text-right">{formatRubFromKopecks(kopStr(totals.salary))}</td>
                  <td className="p-3 text-right">{formatRubFromKopecks(kopStr(totals.advance))}</td>
                  <td className="p-3 text-right">{formatRubFromKopecks(kopStr(totals.bonus))}</td>
                  <td className="text-primary p-3 text-right">
                    {formatRubFromKopecks(kopStr(totals.total))}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="flex items-center gap-4 border-t p-3">
          <button
            type="button"
            onClick={addRow}
            className="text-primary inline-flex items-center gap-1 text-sm font-medium hover:underline"
          >
            <Plus className="h-4 w-4" />
            Добавить строку
          </button>
          {worksQ.isFetching && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" />
              Считаю работы за месяц…
            </span>
          )}
        </div>
      </div>

      {/* ── Годовая сводка ── */}
      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <h3 className="font-semibold">Сводная таблица выплат за год</h3>
          <div className="flex items-center gap-2">
            <label className="text-muted-foreground text-xs">Год</label>
            <input
              type="number"
              value={summaryYear}
              onChange={(e) => setSummaryYear(Number(e.target.value) || now.getFullYear())}
              className="border-input bg-background w-24 rounded-md border px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              type="button"
              onClick={exportSummary}
              disabled={summary.length === 0}
              className="bg-secondary hover:bg-muted inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              Экспорт в Excel
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground uppercase">
              <tr>
                <th className="p-2 text-left font-medium" style={{ minWidth: 150 }}>
                  Сотрудник
                </th>
                {MONTHS_SHORT.map((m) => (
                  <th key={m} className="p-2 text-right font-medium" style={{ minWidth: 56 }}>
                    {m}
                  </th>
                ))}
                <th className="p-2 text-right font-medium" style={{ minWidth: 90 }}>
                  Итого за год
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {summary.length === 0 ? (
                <tr>
                  <td colSpan={14} className="text-muted-foreground p-6 text-center">
                    Нет сохранённых ведомостей за {summaryYear} год
                  </td>
                </tr>
              ) : (
                summary.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/30">
                    <td className="p-2 font-medium">{r.name || '—'}</td>
                    {r.months.map((k, mi) => (
                      <td
                        key={mi}
                        className={cn(
                          'p-2 text-right tabular-nums',
                          k > 0 ? '' : 'text-muted-foreground',
                        )}
                      >
                        {k > 0 ? formatRubFromKopecks(String(k)) : '—'}
                      </td>
                    ))}
                    <td className="text-primary p-2 text-right font-semibold tabular-nums">
                      {formatRubFromKopecks(String(r.yearTotal))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Причина перезаписи ── */}
      {reasonOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setReasonOpen(false)}
        >
          <div
            className="bg-card w-full max-w-md rounded-lg border p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold">
              Перезапись ведомости за {MONTHS_RU[monthIdx]} {year}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              Ведомость за этот месяц уже сохранена. Укажите причину изменения (минимум 10 символов)
              — она попадёт в журнал изменений (требование 402-ФЗ).
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Например: исправлена сумма премии по инженеру Иванову"
              className="border-input bg-background mt-3 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            {saveM.error && (
              <div className="text-destructive mt-2 text-xs">{saveM.error.message}</div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReasonOpen(false)}
                className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-sm font-medium transition"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={reason.trim().length < 10 || saveM.isPending}
                onClick={() => doSave(reason.trim())}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
              >
                {saveM.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Перезаписать
              </button>
            </div>
          </div>
        </div>
      )}

      {postOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPostOpen(false)}
        >
          <div
            className="bg-card w-full max-w-md rounded-lg border p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold">
              Провести в кассу — {MONTHS_RU[monthIdx]} {year}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              Сумма ведомости станет расходом в кассе (статья «Зарплата») — общие деньги (ДДС)
              уменьшатся. Проводится сохранённая сумма; если меняли цифры — сначала сохраните.
            </p>
            <div className="bg-muted/30 mt-3 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span className="text-muted-foreground">Сумма к проведению</span>
              <span className="font-semibold tabular-nums">
                {formatRubFromKopecks(String(savedTotalKop))}
              </span>
            </div>
            <label className="mt-3 block text-sm font-medium">Из счёта</label>
            <select
              value={postAccountId}
              onChange={(e) => setPostAccountId(e.target.value)}
              className="border-input bg-background mt-1 block w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {postM.error && (
              <div className="text-destructive mt-2 text-xs">{postM.error.message}</div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPostOpen(false)}
                className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-sm font-medium transition"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={doPost}
                disabled={!postAccountId || postM.isPending}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
              >
                {postM.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wallet className="h-4 w-4" />
                )}
                Провести
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Удалить ведомость?"
        description={`Ведомость за ${MONTHS_RU[monthIdx]} ${year} будет удалена (можно завести месяц заново).`}
        confirmText="Удалить"
        variant="danger"
        loading={deleteM.isPending}
        error={deleteM.error?.message ?? null}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
