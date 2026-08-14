/**
 * /attendance — журнал учёта посещений (табель) за месяц.
 *
 * Сетка «сотрудники × числа месяца»: в клетке буквенный код вида дня, клик по клетке
 * открывает отметку. Заполняет менеджер или директор вручную — на телефоне у инженера
 * отметок «пришёл/ушёл» нет.
 *
 * Итоги («явок» и «отработано») и печатный табель считаются ОДНИМИ функциями из
 * lib/attendance — чтобы цифра на экране и цифра в подписываемом документе не могли
 * разойтись.
 *
 * Доступ — директор + диспетчер (staffProcedure на бэке). Инженеру показываем
 * вежливый «нет доступа», без редиректа.
 */
import { useMemo, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { openPrintWindow } from '../lib/open-print-window';
import { QueryError } from '../components/QueryError';
import { AttendanceDayForm } from '../components/AttendanceDayForm';
import {
  ATTENDANCE_STATUSES,
  buildAttendanceRows,
  formatWorkedTime,
  indexByUserAndDate,
  monthDays,
  monthTitle,
  statusCode,
  statusLabel,
  summarize,
  type AttendanceRecord,
} from '../lib/attendance';

interface Selection {
  userId: string;
  employeeName: string;
  workDate: string;
}

export function AttendancePage() {
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const isStaff = me.data?.user.role === 'director' || me.data?.user.role === 'dispatcher';

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [printing, setPrinting] = useState(false);

  const monthQ = trpc.attendance.month.useQuery({ year, month }, { enabled: isStaff });

  const days = useMemo(() => monthDays(year, month), [year, month]);
  const records = useMemo(
    () => (monthQ.data?.records ?? []) as AttendanceRecord[],
    [monthQ.data?.records],
  );
  const employees = monthQ.data?.employees ?? [];
  const index = useMemo(() => indexByUserAndDate(records), [records]);

  const shiftMonth = (delta: number) => {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth() + 1);
  };

  const handlePrint = async () => {
    if (!monthQ.data) return;
    setPrinting(true);
    const win = openPrintWindow();
    try {
      const [{ printAttendanceSheet }, { ERFOLG_FALLBACK }] = await Promise.all([
        import('../lib/pdf'),
        import('../lib/pdf/branding'),
      ]);
      const rows = buildAttendanceRows(employees, records, days);
      await printAttendanceSheet(
        {
          tenant: { ...ERFOLG_FALLBACK },
          monthTitle: monthTitle(year, month),
          days: days.map((d) => ({ day: d.day, isWeekend: d.isWeekend })),
          rows: rows.map((r) => ({
            fullName: r.fullName,
            position: r.position,
            codes: r.codes,
            presentDays: r.totals.countByStatus.present,
            workedText: formatWorkedTime(r.totals.workedMinutes),
          })),
          legend: ATTENDANCE_STATUSES.map((s) => ({ code: s.code, label: s.label })),
          compiledBy: me.data?.user.fullName ?? '',
        },
        win,
      );
    } finally {
      setPrinting(false);
    }
  };

  if (me.isLoading) {
    return <div className="text-muted-foreground p-6 text-sm">Загрузка…</div>;
  }

  if (!isStaff) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <div className="bg-card rounded-lg border p-6 text-center">
          <h1 className="text-base font-semibold">Журнал посещений недоступен</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Раздел ведут менеджер и директор. Отметки за вас проставит менеджер.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <CalendarRange className="h-3.5 w-3.5" />
            Учёт посещений
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Журнал посещений</h1>
          <p className="text-muted-foreground text-sm">
            Кто из сотрудников в какой день был на работе. На расчёт зарплаты не влияет.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-md border">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              className="hover:bg-muted rounded-l-md px-2 py-1.5 transition"
              aria-label="Предыдущий месяц"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-36 px-3 py-1.5 text-center text-sm font-medium">
              {monthTitle(year, month)}
            </span>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              className="hover:bg-muted rounded-r-md px-2 py-1.5 transition"
              aria-label="Следующий месяц"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setYear(now.getFullYear());
              setMonth(now.getMonth() + 1);
            }}
            className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm transition"
          >
            Текущий месяц
          </button>
          <button
            type="button"
            onClick={() => void handlePrint()}
            disabled={printing || !monthQ.data}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
          >
            <Printer className="h-4 w-4" />
            {printing ? 'Готовим…' : 'Печать табеля'}
          </button>
        </div>
      </div>

      {monthQ.error && <QueryError error={monthQ.error} onRetry={() => void monthQ.refetch()} />}

      {monthQ.isLoading && <div className="text-muted-foreground text-sm">Загрузка журнала…</div>}

      {monthQ.data && employees.length === 0 && (
        <div className="text-muted-foreground bg-card rounded-lg border p-6 text-sm">
          В компании нет сотрудников для табеля.
        </div>
      )}

      {monthQ.data && employees.length > 0 && (
        <div className="bg-card overflow-x-auto rounded-lg border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-muted/50">
                <th className="bg-card sticky left-0 z-10 border-b border-r px-3 py-2 text-left text-xs font-semibold">
                  Сотрудник
                </th>
                {days.map((d) => (
                  <th
                    key={d.date}
                    className={cn(
                      'border-b px-0 py-2 text-center text-[11px] font-semibold tabular-nums',
                      d.isWeekend && 'bg-muted text-muted-foreground',
                    )}
                  >
                    {d.day}
                  </th>
                ))}
                <th className="border-b border-l px-2 py-2 text-center text-[11px] font-semibold">
                  Явок
                </th>
                <th className="border-b px-2 py-2 text-center text-[11px] font-semibold">
                  Отработано
                </th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => {
                const byDate = index.get(e.userId);
                const totals = summarize(byDate ? [...byDate.values()] : []);
                return (
                  <tr key={e.userId} className="hover:bg-muted/30">
                    <td className="bg-card sticky left-0 z-10 whitespace-nowrap border-b border-r px-3 py-1.5">
                      <span className={cn(!e.isActive && 'text-muted-foreground')}>
                        {e.fullName}
                      </span>
                      {!e.isActive && (
                        <span className="text-muted-foreground ml-1.5 text-[11px]">
                          (не работает)
                        </span>
                      )}
                    </td>
                    {days.map((d) => {
                      const rec = byDate?.get(d.date);
                      return (
                        <td
                          key={d.date}
                          className={cn('border-b p-0 text-center', d.isWeekend && 'bg-muted/40')}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setSelection({
                                userId: e.userId,
                                employeeName: e.fullName,
                                workDate: d.date,
                              })
                            }
                            title={
                              rec
                                ? `${statusLabel(rec.status)}${
                                    rec.arrivedAt ? `, ${rec.arrivedAt}–${rec.leftAt ?? '…'}` : ''
                                  }`
                                : 'Поставить отметку'
                            }
                            aria-label={`${e.fullName}, ${d.day} число: ${
                              rec ? statusLabel(rec.status) : 'отметки нет'
                            }`}
                            className={cn(
                              'hover:bg-primary/15 h-7 w-full text-[11px] font-semibold transition',
                              rec?.status === 'present' && 'text-primary',
                              rec?.status === 'absent' && 'text-destructive',
                              !rec && 'text-muted-foreground/40',
                            )}
                          >
                            {rec ? statusCode(rec.status) : '·'}
                          </button>
                        </td>
                      );
                    })}
                    <td className="border-b border-l px-2 py-1.5 text-center font-semibold tabular-nums">
                      {totals.countByStatus.present}
                    </td>
                    <td className="text-muted-foreground whitespace-nowrap border-b px-2 py-1.5 text-center text-xs">
                      {formatWorkedTime(totals.workedMinutes)}
                      {totals.presentWithoutTime > 0 && (
                        <span
                          className="ml-1"
                          title={`Явок без времени: ${totals.presentWithoutTime} — их часы в сумму не вошли`}
                        >
                          *
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-muted-foreground text-xs">
        Обозначения:{' '}
        {ATTENDANCE_STATUSES.map((s) => `${s.code} — ${s.label.toLowerCase()}`).join(', ')}.
        Звёздочка в колонке «Отработано» — есть явки без указанного времени, их часы в сумму не
        вошли.
      </div>

      {selection && (
        <AttendanceDayForm
          userId={selection.userId}
          employeeName={selection.employeeName}
          workDate={selection.workDate}
          record={index.get(selection.userId)?.get(selection.workDate) ?? null}
          onClose={() => setSelection(null)}
          onSaved={() => {
            setSelection(null);
            void utils.attendance.month.invalidate();
          }}
        />
      )}
    </div>
  );
}
