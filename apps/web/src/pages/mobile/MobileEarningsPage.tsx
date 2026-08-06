import { useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowLeft,
  Banknote,
  ClipboardCheck,
  Info,
  Loader2,
  Percent,
  Wallet,
  Wrench,
} from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { formatRubWhole } from '../../lib/money';
import { QueryError } from '../../components/QueryError';
import { SegmentedTabs } from '../../components/SegmentedTabs';

type Period = 'today' | 'week' | 'month' | 'quarter';

const PERIOD_LABEL: Record<Period, string> = {
  today: 'День',
  week: 'Неделя',
  month: 'Месяц',
  quarter: 'Квартал',
};

/**
 * /m/earnings — «Мой заработок» инженера: сколько начислено за закрытые в периоде
 * наряды. Показываем ОТДЕЛЬНО «проценты за ремонт» (главное, что просит инженер)
 * и оклад, если он задан. Считает сервер (payroll.myEarnings, только по себе).
 *
 * Эффективный % берём из фактической суммы (piece/works), а НЕ из глобального
 * rule: у сотрудника может быть персональная ставка, и глобальный процент соврал бы.
 */
export function MobileEarningsPage() {
  const [period, setPeriod] = useState<Period>('month');
  const me = trpc.auth.me.useQuery();
  // Раздел «Зарплата» может быть отключён в компании — тогда экран заработка не
  // грузим (как и карточка в профиле, MobileProfilePage). disabledModules — UI-гейт.
  const moduleDisabled = me.data?.tenant.disabledModules.includes('payroll') ?? false;
  const q = trpc.payroll.myEarnings.useQuery(
    { preset: period },
    { enabled: !!me.data && !moduleDisabled },
  );

  // Директор мог отключить показ заработка — тогда сервер отдаёт { enabled: false }.
  const data = q.data?.enabled ? q.data : null;
  const disabled = moduleDisabled || q.data?.enabled === false;
  const row = data?.rows[0];
  const works = row ? BigInt(row.worksAmountKopecks) : 0n;
  const piece = row ? BigInt(row.pieceworkPartKopecks) : 0n;
  const base = row ? BigInt(row.baseSalaryKopecks) : 0n;
  const total = data ? BigInt(data.grandTotalKopecks) : 0n;
  const effectivePercent =
    works > 0n && piece > 0n ? Math.round((Number(piece) / Number(works)) * 100) : null;

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <Link
          href="/m/profile"
          className="text-muted-foreground hover:text-foreground -ml-1 grid h-9 w-9 place-items-center rounded-lg"
          aria-label="Назад в профиль"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-base font-semibold leading-tight">Мой заработок</h1>
          <p className="text-muted-foreground text-xs">По закрытым нарядам</p>
        </div>
      </div>

      <SegmentedTabs
        grow
        options={(['today', 'week', 'month', 'quarter'] as const).map((p) => ({
          value: p,
          label: PERIOD_LABEL[p],
        }))}
        value={period}
        onChange={setPeriod}
      />

      {q.isLoading && (
        <div className="bg-card flex items-center gap-3 rounded-lg border p-4">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">Считаем…</span>
        </div>
      )}

      {(q.error || (q.fetchStatus === 'paused' && !q.data)) && (
        <QueryError
          error={q.error}
          paused={q.fetchStatus === 'paused'}
          what="заработок"
          onRetry={() => void q.refetch()}
        />
      )}

      {disabled && (
        <div className="bg-card text-muted-foreground flex items-start gap-2 rounded-lg border p-4 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {moduleDisabled
              ? 'Раздел «Зарплата» отключён в компании.'
              : 'Показ заработка сейчас отключён директором.'}
          </span>
        </div>
      )}

      {data && (
        <>
          {/* Итог к выплате за период */}
          <div className="bg-card rounded-xl border p-5">
            <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium uppercase">
              <Wallet className="h-3.5 w-3.5" />К выплате · {PERIOD_LABEL[period]}
            </div>
            <div className="text-success mt-1 text-4xl font-semibold tabular-nums">
              {formatRubWhole(total.toString())}
            </div>
          </div>

          {/* Проценты за ремонт — то, ради чего экран */}
          <div className="bg-primary/5 border-primary/20 rounded-xl border p-4">
            <div className="text-primary flex items-center gap-1.5 text-[11px] font-medium uppercase">
              <Percent className="h-3.5 w-3.5" />
              Проценты за ремонт
            </div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">
              {formatRubWhole(piece.toString())}
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {effectivePercent !== null
                ? `${effectivePercent}% от суммы работ ${formatRubWhole(works.toString())}`
                : `от суммы работ ${formatRubWhole(works.toString())}`}
            </div>
          </div>

          {/* Оклад — показываем только если задан персонально */}
          {base > 0n && (
            <div className="bg-card rounded-xl border p-4">
              <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium uppercase">
                <Banknote className="h-3.5 w-3.5" />
                Оклад
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {formatRubWhole(base.toString())}
              </div>
              <div className="text-muted-foreground mt-1 text-xs">
                начисляется помесячно
                {period !== 'month' && ' · показан за месяц целиком'}
              </div>
            </div>
          )}

          {/* Контекст: наряды и сумма работ */}
          <div className="bg-card grid grid-cols-2 divide-x rounded-xl border">
            <div className="p-4">
              <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium uppercase">
                <ClipboardCheck className="h-3.5 w-3.5" />
                Закрыто нарядов
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {row?.closedOrdersCount ?? 0}
              </div>
            </div>
            <div className="p-4">
              <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium uppercase">
                <Wrench className="h-3.5 w-3.5" />
                Сумма работ
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatRubWhole(works.toString())}
              </div>
            </div>
          </div>

          <div className="text-muted-foreground flex items-start gap-2 px-1 text-xs leading-relaxed">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Считается по нарядам, закрытым за выбранный период. Это предварительный расчёт —
              выплату проводит директор.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
