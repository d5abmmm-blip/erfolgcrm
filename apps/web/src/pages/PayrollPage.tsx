import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Check, Loader2, Pencil, Save, Settings as SettingsIcon, Wallet, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

type Period = 'today' | 'week' | 'month' | 'quarter';
type PayrollMode = 'piecework' | 'salary_bonus';

type PayoutRow = {
  engineerId: string;
  engineerName: string;
  totalEarningsKopecks: string;
  baseSalaryKopecks: string;
};
type Payout = {
  id: string;
  engineerId: string;
  amountKopecks: string;
  computedKopecks: string;
  paidOn: string;
  accountId: string;
  comment: string | null;
};
type CashAccount = { id: string; name: string; kind: 'cash' | 'bank' | 'card' };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function kopecksToRubInput(kopStr: string): string {
  return (Number(BigInt(kopStr)) / 100).toString();
}
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
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<Period>('month');
  const ruleQ = trpc.payroll.getRule.useQuery();
  const payoutsQ = trpc.payroll.computePayouts.useQuery({ preset: period });
  const paidQ = trpc.payroll.listPayouts.useQuery({ preset: period });
  const accountsQ = trpc.cash.accounts.list.useQuery();

  const [modal, setModal] = useState<{ row: PayoutRow; existing: Payout | null } | null>(null);
  const [toCancel, setToCancel] = useState<Payout | null>(null);

  const deletePayoutM = trpc.payroll.deletePayout.useMutation({
    onSuccess: () => {
      void utils.payroll.listPayouts.invalidate();
      void utils.cash.invalidate();
      setToCancel(null);
    },
  });

  const paidByEngineer = new Map<string, Payout>(
    (paidQ.data ?? []).map((p) => [p.engineerId, p]),
  );
  const accounts: CashAccount[] = accountsQ.data ?? [];

  // Оклад — МЕСЯЧНЫЙ и на не-месячных периодах показывается целиком (не пропорционально).
  // Если в ведомости есть окладники и выбран не «Месяц» — предупреждаем директора, чтобы
  // он не выплатил полный оклад за неделю/квартал по ошибке.
  const hasSalaryRows = (payoutsQ.data?.rows ?? []).some(
    (r) => BigInt(r.baseSalaryKopecks) > 0n,
  );
  const salaryPeriodWarning = period !== 'month' && hasSalaryRows;

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

          {salaryPeriodWarning && (
            <div className="bg-warning/10 text-warning border-warning/30 rounded-lg border p-3 text-sm">
              Оклад начисляется <span className="font-medium">помесячно</span> и на периоде «
              {PERIOD_LABEL[period]}» показан за полный месяц. Для выплаты оклада выбирайте период
              «Месяц» — иначе сумма к выплате будет завышена.
            </div>
          )}

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
                  <th className="p-3 text-right font-medium">Выплата</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {payoutsQ.data.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-muted-foreground p-6 text-center">
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
                    <td className="p-3 text-right">
                      <PayoutCell
                        existing={paidByEngineer.get(r.engineerId) ?? null}
                        canPay={accounts.length > 0 && BigInt(r.totalEarningsKopecks) > 0n}
                        onPay={() => setModal({ row: r, existing: null })}
                        onEdit={(p) => setModal({ row: r, existing: p })}
                        onCancel={(p) => setToCancel(p)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!accountsQ.isLoading && accounts.length === 0 && (
        <div className="text-muted-foreground bg-card rounded-lg border border-dashed p-4 text-sm">
          Чтобы проводить выплаты, заведите денежный счёт в{' '}
          <Link href="/finance/accounts" className="text-primary hover:underline">
            кассе
          </Link>
          .
        </div>
      )}

      {modal && (
        <PayoutModal
          row={modal.row}
          existing={modal.existing}
          period={period}
          accounts={accounts}
          onClose={() => setModal(null)}
          onSaved={() => {
            void utils.payroll.listPayouts.invalidate();
            void utils.cash.invalidate();
            setModal(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!toCancel}
        title="Отменить выплату?"
        description="Запись о выплате будет удалена, а связанный расход — убран из кассы (остаток счёта вернётся)."
        confirmText="Отменить выплату"
        variant="danger"
        loading={deletePayoutM.isPending}
        onConfirm={() => toCancel && deletePayoutM.mutate({ id: toCancel.id })}
        onCancel={() => setToCancel(null)}
      />
    </div>
  );
}

/* ===================== Выплата: ячейка + окно ===================== */

function PayoutCell({
  existing,
  canPay,
  onPay,
  onEdit,
  onCancel,
}: {
  existing: Payout | null;
  canPay: boolean;
  onPay: () => void;
  onEdit: (p: Payout) => void;
  onCancel: (p: Payout) => void;
}) {
  if (existing) {
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="text-success inline-flex items-center gap-1 text-xs font-medium">
          <Check className="h-3.5 w-3.5" />
          {new Date(existing.paidOn).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
        </span>
        <button
          type="button"
          title="Изменить выплату"
          onClick={() => onEdit(existing)}
          className="hover:bg-muted text-muted-foreground rounded p-1 transition"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Отменить выплату"
          onClick={() => onCancel(existing)}
          className="hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded p-1 transition"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={!canPay}
      onClick={onPay}
      className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition disabled:opacity-40"
    >
      <Wallet className="h-3.5 w-3.5" />
      Выплатить
    </button>
  );
}

function PayoutModal({
  row,
  existing,
  period,
  accounts,
  onClose,
  onSaved,
}: {
  row: PayoutRow;
  existing: Payout | null;
  period: Period;
  accounts: CashAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [amountRub, setAmountRub] = useState(() =>
    kopecksToRubInput(existing?.amountKopecks ?? row.totalEarningsKopecks),
  );
  const [paidOn, setPaidOn] = useState(() => existing?.paidOn ?? todayIso());
  const [accountId, setAccountId] = useState(() => existing?.accountId ?? accounts[0]?.id ?? '');
  const [comment, setComment] = useState(
    () => existing?.comment ?? `ЗП · ${row.engineerName}`,
  );

  const createM = trpc.payroll.createPayout.useMutation({ onSuccess: onSaved });
  const updateM = trpc.payroll.updatePayout.useMutation({ onSuccess: onSaved });
  const pending = createM.isPending || updateM.isPending;
  const error = createM.error?.message ?? updateM.error?.message;

  const amountNum = parseRubNumber(amountRub);
  const valid = amountNum > 0 && !!accountId && !!paidOn;
  const computedRub = kopecksToRubInput(existing?.computedKopecks ?? row.totalEarningsKopecks);
  // Оклад месячный: на не-месячном периоде расчёт включает полный оклад — предупреждаем.
  const salaryWarning = !isEdit && period !== 'month' && BigInt(row.baseSalaryKopecks) > 0n;

  const submit = () => {
    if (!valid) return;
    if (isEdit && existing) {
      updateM.mutate({ id: existing.id, amountRub: amountNum, paidOn, accountId, comment });
    } else {
      createM.mutate({ preset: period, engineerId: row.engineerId, amountRub: amountNum, paidOn, accountId, comment });
    }
  };

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center">
      <button type="button" aria-label="Закрыть" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="bg-card relative z-10 w-full max-w-md rounded-lg border p-5 shadow-xl">
        <h3 className="text-base font-semibold">
          {isEdit ? 'Изменить выплату' : 'Выплатить ЗП'} · {row.engineerName}
        </h3>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-sm font-medium">Сумма к выплате, ₽</label>
            <input
              type="text"
              inputMode="decimal"
              value={amountRub}
              onChange={(e) => setAmountRub(e.target.value)}
              autoFocus
              className="border-input bg-background focus:ring-primary/40 mt-1 block w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2"
            />
            <p className="text-muted-foreground mt-1 text-xs">
              Посчитано системой: {computedRub} ₽ · можно изменить вручную
            </p>
            {salaryWarning && (
              <p className="text-warning bg-warning/10 border-warning/30 mt-2 rounded-md border p-2 text-xs">
                Внимание: сюда включён <span className="font-medium">полный месячный оклад</span> (период
                «{PERIOD_LABEL[period]}»). Проверьте сумму — за неполный период оклад платить не нужно.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Дата</label>
              <input
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
                className="border-input bg-background focus:ring-primary/40 mt-1 block w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Из счёта</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="border-input bg-background focus:ring-primary/40 mt-1 block w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Комментарий</label>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="border-input bg-background focus:ring-primary/40 mt-1 block w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2"
            />
          </div>

          {error && (
            <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/30 p-2 text-xs">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!valid || pending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {isEdit ? 'Сохранить' : 'Выплатить'}
          </button>
        </div>
      </div>
    </div>
  );
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
  const usersQ = trpc.users.list.useQuery({ onlyEngineers: true });
  const staffQ = trpc.users.list.useQuery();

  const setRuleM = trpc.payroll.setRule.useMutation({
    onSuccess: () => utils.payroll.getRule.invalidate(),
  });
  const setRateM = trpc.users.setHourlyCostRate.useMutation({
    onSuccess: () => utils.users.list.invalidate(),
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
