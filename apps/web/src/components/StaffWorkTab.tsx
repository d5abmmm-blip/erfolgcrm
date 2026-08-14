/**
 * Карточка сотрудника, вкладка «Работа»: что человек сделал за период.
 *
 * Подача взята из прежней CRM владельца (ему нравилась та карточка инженера): полоса
 * показателей, переключатель периода, столбики по времени, чипы-фильтры со счётчиками,
 * «последние пять и ссылка на все». Не взято оттуда сознательно:
 *
 *   • рейтинг команды, места и медали — на 69 своих заявках «первый в компании»
 *     получается случайно, а висеть будет как факт;
 *   • любые проценты по человеку — при 2-4 заявках одна закрытая даёт «100 %»;
 *   • деньги — вкладку видит менеджер, суммы по людям живут отдельной вкладкой
 *     под директором, и сервер их сюда не отдаёт вовсе.
 *
 * Прочерк вместо нуля — правило для всех чисел: «0» означает настоящий ноль, а не
 * «данных нет». На этой базе разница принципиальна.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { CalendarRange, CheckCircle2, Clock, Users, Wrench } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { QueryError } from './QueryError';
import { ticketStatusRu, ticketsWord } from '../lib/staff';
import {
  avgDaysPhrase,
  closedPhrase,
  weekLabel,
  workPeriod,
  WORK_PERIOD_LABELS,
  type WorkPeriodKind,
} from '../lib/staff-work';

const PERIOD_ORDER: WorkPeriodKind[] = ['month', 'quarter', 'all'];

export function StaffWorkTab({ userId }: { userId: string }) {
  const [kind, setKind] = useState<WorkPeriodKind>('month');
  // Отсечку берём с сервера — дата «с какого дня считаем людей» живёт там одна.
  const cardQ = trpc.staff.get.useQuery({ userId });
  const statsSince = cardQ.data?.statsSince ?? new Date('2026-07-05T00:00:00Z');

  const period = useMemo(
    () => workPeriod(kind, new Date(), statsSince),
    [kind, statsSince.getTime()],
  );

  const workQ = trpc.staff.work.useQuery({ userId, from: period.from, to: period.to });
  const work = workQ.data?.work;

  const maxWeek = Math.max(1, ...(work?.byWeek.map((w) => w.closed) ?? [0]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs font-medium">Период:</span>
        {PERIOD_ORDER.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setKind(p)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition',
              kind === p
                ? 'border-primary bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {WORK_PERIOD_LABELS[p]}
          </button>
        ))}
        {workQ.data && (
          <span className="text-muted-foreground ml-auto text-[11px]">
            считаем {workQ.data.statsSinceLabel}
          </span>
        )}
      </div>

      {workQ.error && <QueryError error={workQ.error} onRetry={() => void workQ.refetch()} />}
      {workQ.isLoading && <div className="text-muted-foreground text-sm">Загрузка…</div>}

      {work && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              icon={CheckCircle2}
              label="Закрыто за период"
              value={work.totals.closedInPeriod === 0 ? '—' : String(work.totals.closedInPeriod)}
            />
            <Tile icon={Wrench} label="Сейчас в работе" value={String(work.totals.openNow)} />
            <Tile
              icon={Clock}
              label="Среднее закрытие"
              value={avgDaysPhrase(work.totals.avgCloseDays)}
            />
            <Tile
              icon={Users}
              label="Вторым инженером"
              value={work.totals.helperInPeriod === 0 ? '—' : String(work.totals.helperInPeriod)}
            />
          </div>

          <section className="bg-card rounded-lg border">
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <CalendarRange className="text-muted-foreground h-3.5 w-3.5" />
              <h2 className="text-sm font-semibold">По неделям</h2>
              <span className="text-muted-foreground ml-auto text-xs">
                {closedPhrase(work.totals.closedInPeriod)}
              </span>
            </header>
            <div className="p-4">
              {work.byWeek.length === 0 ? (
                <p className="text-muted-foreground text-sm">Период пуст.</p>
              ) : (
                <WeekBars weeks={work.byWeek} max={maxWeek} />
              )}
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="bg-card rounded-lg border">
              <header className="border-b px-4 py-3">
                <h2 className="text-sm font-semibold">Заявки на человеке сейчас</h2>
              </header>
              <div className="space-y-2 p-4">
                {work.byStatus.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Заявок нет.</p>
                ) : (
                  work.byStatus.map((s) => (
                    <div key={s.status} className="flex items-center gap-3 text-sm">
                      <span className="w-32 shrink-0">{ticketStatusRu(s.status)}</span>
                      <span className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                        <span
                          className="bg-primary/70 block h-full rounded-full"
                          style={{
                            width: `${Math.round((s.count / Math.max(...work.byStatus.map((x) => x.count))) * 100)}%`,
                          }}
                        />
                      </span>
                      <span className="w-8 text-right tabular-nums">{s.count}</span>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="bg-card rounded-lg border">
              <header className="border-b px-4 py-3">
                <h2 className="text-sm font-semibold">Чаще всего за период</h2>
              </header>
              <div className="grid gap-4 p-4 sm:grid-cols-2">
                <TopList
                  title="Клиенты"
                  rows={work.topClients.map((c) => ({
                    key: c.clientId,
                    name: c.name,
                    n: c.closed,
                  }))}
                />
                <TopList
                  title="Техника"
                  rows={work.topDeviceTypes.map((d, i) => ({
                    key: `${d.deviceType ?? 'no-type'}-${i}`,
                    name: d.deviceType ?? 'без типа',
                    n: d.closed,
                  }))}
                />
              </div>
            </section>
          </div>

          <section className="bg-card rounded-lg border">
            <header className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Последние закрытые</h2>
              <Link
                href={`/tickets?engineer=${userId}`}
                className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
              >
                Все заявки →
              </Link>
            </header>
            {work.recent.length === 0 ? (
              <p className="text-muted-foreground p-4 text-sm">
                За выбранный период закрытых заявок нет.
              </p>
            ) : (
              <ul className="divide-y">
                {work.recent.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/tickets/${t.id}`}
                      className="hover:bg-muted/40 flex items-center gap-3 px-4 py-2.5 transition"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs font-medium">{t.ticketNumber}</div>
                        <div className="text-muted-foreground truncate text-xs">
                          {[t.clientName, t.assetModel].filter(Boolean).join(' · ') || '—'}
                        </div>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {t.closedAt
                          ? new Date(t.closedAt).toLocaleDateString('ru-RU', {
                              day: 'numeric',
                              month: 'short',
                            })
                          : '—'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-muted-foreground text-[11px]">
            Считаются только заявки, заведённые в этой программе: в перенесённом архиве исполнитель
            не указан — там работали под одной учётной записью. Помощник на чужой заявке в «закрыто»
            не идёт, он посчитан отдельной плиткой.
          </p>
        </>
      )}
    </div>
  );
}

/** Столбики по неделям на SVG: координаты в атрибутах, цвет — классом темы. */
function WeekBars({
  weeks,
  max,
}: {
  weeks: Array<{ weekStart: string; closed: number }>;
  max: number;
}) {
  const barWidth = 100 / weeks.length;
  return (
    <div>
      <svg viewBox="0 0 100 34" preserveAspectRatio="none" className="h-24 w-full" role="img">
        {weeks.map((w, i) => {
          const height = w.closed === 0 ? 0.6 : (w.closed / max) * 30;
          return (
            <rect
              key={w.weekStart}
              x={i * barWidth + barWidth * 0.15}
              y={32 - height}
              width={barWidth * 0.7}
              height={height}
              rx={0.6}
              className={w.closed === 0 ? 'fill-muted-foreground/25' : 'fill-primary/70'}
            />
          );
        })}
      </svg>
      <div className="text-muted-foreground mt-1 flex text-[10px]">
        {weeks.map((w) => (
          <span key={w.weekStart} className="flex-1 text-center">
            {weeks.length <= 8 ? weekLabel(w.weekStart) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function TopList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; name: string; n: number }>;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wide">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">—</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.key} className="flex items-baseline gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {r.n} {ticketsWord(r.n)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Tile({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
