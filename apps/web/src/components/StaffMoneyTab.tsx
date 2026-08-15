/**
 * Карточка сотрудника, вкладка «Деньги» (видит только директор; сервер отдаёт её
 * directorProcedure — менеджеру откажет и при прямом вызове).
 *
 * Что здесь и почему:
 *   • период только помесячный: оклад месячный и прибавляется один раз, «за всё
 *     время» врало бы в сумме (см. lib/staff-money.ts);
 *   • начисление — из payroll.computePayouts, та же цифра, что на странице
 *     «Зарплата»; своего расчёта у вкладки нет;
 *   • уволенному расчёт не показывается вовсе: computePayouts не видит неактивных,
 *     и «0 ₽» у бывшего читалось бы как «ничего не заработал». Словами честнее.
 */
import { useMemo, useState } from 'react';
import { Banknote, FileSpreadsheet, Percent, Wallet } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { QueryError } from './QueryError';
import { formatRub } from '../lib/money';
import { formatDateRu } from '../lib/staff-hr';
import { monthOptions, monthTitleRu, payoutKindRu } from '../lib/staff-money';

export function StaffMoneyTab({ userId }: { userId: string }) {
  // Отсечка «с какого месяца считаем» приходит с сервера вместе с карточкой.
  const cardQ = trpc.staff.get.useQuery({ userId });
  const statsSince = cardQ.data?.statsSince ?? new Date('2026-07-05T00:00:00Z');

  const months = useMemo(
    () => monthOptions(new Date(), statsSince),
    // statsSince — новый объект Date на каждый рендер, сравниваем по значению.
    [statsSince.getTime()],
  );
  const [month, setMonth] = useState(() => monthOptions(new Date(), new Date())[0]!);

  const moneyQ = trpc.payroll.staffMoney.useQuery({ userId, month });
  const money = moneyQ.data;

  const idx = months.indexOf(month);
  const older = idx >= 0 && idx < months.length - 1 ? months[idx + 1] : null;
  const newer = idx > 0 ? months[idx - 1] : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs font-medium">Месяц:</span>
        <div className="inline-flex items-center rounded-md border">
          <button
            type="button"
            disabled={!older}
            onClick={() => older && setMonth(older)}
            className="text-muted-foreground hover:text-foreground px-2.5 py-1 text-sm transition disabled:opacity-30"
            aria-label="Предыдущий месяц"
          >
            ←
          </button>
          <span className="min-w-32 px-2 text-center text-xs font-medium">
            {monthTitleRu(month)}
          </span>
          <button
            type="button"
            disabled={!newer}
            onClick={() => newer && setMonth(newer)}
            className="text-muted-foreground hover:text-foreground px-2.5 py-1 text-sm transition disabled:opacity-30"
            aria-label="Следующий месяц"
          >
            →
          </button>
        </div>
        <span className="text-muted-foreground ml-auto text-[11px]">
          те же цифры, что на странице «Зарплата»
        </span>
      </div>

      {moneyQ.error && <QueryError error={moneyQ.error} onRetry={() => void moneyQ.refetch()} />}
      {moneyQ.isLoading && <div className="text-muted-foreground text-sm">Загрузка…</div>}

      {money && (
        <>
          {!money.isActive && (
            <div className="bg-muted/40 text-muted-foreground rounded-lg border p-4 text-sm">
              Сотрудник не работает, начисление по нему не считается: расчёт зарплаты ведётся только
              по действующим людям. Чтобы рассчитать бывшего сотрудника, его нужно временно вернуть
              в активные в настройках пользователей. История выплат и ведомостей — ниже, она
              сохраняется.
            </div>
          )}

          <section className="bg-card rounded-lg border">
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <Percent className="text-muted-foreground h-3.5 w-3.5" />
              <h2 className="text-sm font-semibold">Условия оплаты</h2>
            </header>
            <div className="p-4 text-sm">
              {money.config.hasPersonal ? (
                <p>
                  Личные условия:{' '}
                  {money.config.personalBaseSalaryKopecks !== null && (
                    <>
                      оклад{' '}
                      <b className="tabular-nums">
                        {formatRub(money.config.personalBaseSalaryKopecks)}
                      </b>{' '}
                      в месяц{money.config.personalBonusPercent !== null && ' + '}
                    </>
                  )}
                  {money.config.personalBonusPercent !== null && (
                    <>
                      <b className="tabular-nums">{money.config.personalBonusPercent} %</b> от работ
                    </>
                  )}
                </p>
              ) : (
                <p>
                  Личных условий нет — действует общее правило:{' '}
                  {money.config.ruleMode === 'salary_bonus' ? (
                    <>
                      оклад{' '}
                      <b className="tabular-nums">
                        {formatRub(money.config.ruleBaseSalaryKopecks)}
                      </b>{' '}
                      в месяц + <b className="tabular-nums">{money.config.ruleBonusPercent} %</b> от
                      работ
                    </>
                  ) : (
                    <>
                      сделка <b className="tabular-nums">{money.config.rulePieceworkPercent} %</b>{' '}
                      от работ
                    </>
                  )}
                </p>
              )}
              {!money.isActive && money.config.hasPersonal && (
                <p className="text-muted-foreground mt-1 text-xs">
                  Личные условия записаны, но не применяются: сотрудник не работает.
                </p>
              )}
            </div>
          </section>

          {money.isActive && (
            <section className="bg-card rounded-lg border">
              <header className="flex items-center gap-2 border-b px-4 py-3">
                <Banknote className="text-muted-foreground h-3.5 w-3.5" />
                <h2 className="text-sm font-semibold">Начислено за {monthTitleRu(month)}</h2>
              </header>
              {money.earnings ? (
                <div className="p-4">
                  <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                    <MoneyTile
                      label="работы за месяц"
                      value={formatRub(money.earnings.worksAmountKopecks)}
                      hint={`закрыто нарядов: ${money.earnings.closedOrdersCount}`}
                    />
                    <MoneyTile
                      label={`от работ (${money.config.effectiveWorkPercent} %)`}
                      value={formatRub(money.earnings.pieceworkPartKopecks)}
                    />
                    <MoneyTile label="оклад" value={formatRub(money.earnings.baseSalaryKopecks)} />
                    <MoneyTile
                      label="итого начислено"
                      value={formatRub(money.earnings.totalEarningsKopecks)}
                      strong
                    />
                  </div>
                  <p className="text-muted-foreground mt-3 text-[11px]">
                    Считается по заявкам, закрытым в выбранном месяце. Работы, перенесённые из
                    старой программы, в начисление не входят — они оплачены ещё там. Оклад месячный
                    и показан целиком.
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground p-4 text-sm">
                  За этот месяц начислений нет: закрытых работ не было, личный оклад не задан.
                </p>
              )}
            </section>
          )}

          <section className="bg-card rounded-lg border">
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <FileSpreadsheet className="text-muted-foreground h-3.5 w-3.5" />
              <h2 className="text-sm font-semibold">В ведомостях</h2>
            </header>
            {money.sheetRows.length === 0 ? (
              <p className="text-muted-foreground p-4 text-sm">
                В сохранённых ведомостях этого человека нет. Ведомости ведутся на странице
                «Зарплата».
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground border-b text-left text-[11px] uppercase tracking-wide">
                      <th className="px-4 py-2 font-medium">Месяц</th>
                      <th className="px-2 py-2 text-right font-medium">Оклад</th>
                      <th className="px-2 py-2 text-right font-medium">Сделка</th>
                      <th className="px-2 py-2 text-right font-medium">Премия</th>
                      <th className="px-2 py-2 text-right font-medium">Аванс</th>
                      <th className="px-2 py-2 text-right font-medium">К выплате</th>
                      <th className="px-4 py-2 font-medium">Касса</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {money.sheetRows.map((r) => (
                      <tr key={r.month}>
                        <td className="px-4 py-2">{monthTitleRu(r.month)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatRub(r.salaryKopecks)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatRub(r.pieceworkKopecks)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatRub(r.bonusKopecks)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatRub(r.advanceKopecks)}
                        </td>
                        <td className="px-2 py-2 text-right font-medium tabular-nums">
                          {formatRub(r.toPayKopecks)}
                        </td>
                        <td
                          className={cn(
                            'px-4 py-2 text-xs',
                            r.posted ? 'text-success' : 'text-muted-foreground',
                          )}
                        >
                          {r.posted ? 'проведена' : 'черновик'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="bg-card rounded-lg border">
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <Wallet className="text-muted-foreground h-3.5 w-3.5" />
              <h2 className="text-sm font-semibold">Выплаты через кассу</h2>
            </header>
            {money.payouts.length === 0 ? (
              <p className="text-muted-foreground p-4 text-sm">
                Выплат через кассу не записано. Они появляются, когда на странице «Зарплата»
                проводят аванс, расчёт или премию.
              </p>
            ) : (
              <ul className="divide-y">
                {money.payouts.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="text-muted-foreground w-24 shrink-0 text-xs">
                      {formatDateRu(p.paidOn)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {payoutKindRu(p.kind)}
                      {p.comment && <span className="text-muted-foreground"> · {p.comment}</span>}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">
                      {formatRub(p.amountKopecks)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function MoneyTile({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className={cn('rounded-md px-3 py-2', strong ? 'bg-primary/10' : 'bg-muted/40')}>
      <div className="text-muted-foreground text-[10px] uppercase tracking-wide">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums leading-none">{value}</div>
      {hint && <div className="text-muted-foreground mt-1 text-[10px]">{hint}</div>}
    </div>
  );
}
