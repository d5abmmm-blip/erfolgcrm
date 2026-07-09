/**
 * Stage 11 — /schedule. График загрузки инженеров (staff-only).
 *
 * Layout:
 *   ┌─────────────┬───────────────────────────────────┐
 *   │ Sidebar     │ WeekScheduleCalendar (день недели)│
 *   │ Unscheduled │                                   │
 *   └─────────────┴───────────────────────────────────┘
 *
 * Состояние weekStart хранится в useState; клик «← / Сегодня / →» сдвигает
 * на 7 дней или возвращает на текущую неделю.
 *
 * Доступ — директор + диспетчер (staffProcedure на бэке). Инженеру показываем
 * вежливый «нет доступа», без редиректа — он может вернуться через меню.
 */
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  WeekScheduleCalendar,
  type ScheduledTicket,
} from '../components/WeekScheduleCalendar';
import { UnscheduledTicketsList } from '../components/UnscheduledTicketsList';

interface UserListRow {
  id: string;
  fullName: string;
  role: 'director' | 'dispatcher' | 'engineer';
  isActive: boolean;
}

const RU_MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

/** Возвращает копию `d`, нормализованную в начало понедельника локального времени. */
function getMondayOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  // JS getDay(): 0=Sun, 1=Mon, … 6=Sat. Хотим Mon=0 → берём (day+6)%7.
  const dayFromMon = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - dayFromMon);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function formatWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  const sameYear = weekStart.getFullYear() === end.getFullYear();
  const sd = weekStart.getDate();
  const ed = end.getDate();
  const sm = RU_MONTHS[weekStart.getMonth()];
  const em = RU_MONTHS[end.getMonth()];
  const sy = weekStart.getFullYear();
  const ey = end.getFullYear();

  if (sameMonth && sameYear) return `${sd}–${ed} ${sm} ${sy}`;
  if (sameYear) return `${sd} ${sm} – ${ed} ${em} ${sy}`;
  return `${sd} ${sm} ${sy} – ${ed} ${em} ${ey}`;
}

export function SchedulePage() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();

  const [weekStart, setWeekStart] = useState<Date>(() => getMondayOfWeek(new Date()));
  const [toast, setToast] = useState<string | null>(null);

  const isStaff =
    me.data?.user.role === 'director' || me.data?.user.role === 'dispatcher';

  const engineersQ = trpc.users.list.useQuery(
    { onlyEngineers: true },
    { enabled: isStaff },
  );

  const scheduleQ = trpc.tickets.weeklySchedule.useQuery(
    { weekStart },
    { enabled: isStaff },
  );

  const scheduleMut = trpc.tickets.schedule.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.tickets.weeklySchedule.invalidate(),
        utils.tickets.list.invalidate(),
      ]);
    },
    onError: (err) => {
      setToast(err.message ?? 'Не удалось поставить заявку в график');
      setTimeout(() => setToast(null), 4000);
    },
  });

  const unscheduleMut = trpc.tickets.unschedule.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.tickets.weeklySchedule.invalidate(),
        utils.tickets.list.invalidate(),
      ]);
    },
    onError: (err) => {
      setToast(err.message ?? 'Не удалось снять заявку с расписания');
      setTimeout(() => setToast(null), 4000);
    },
  });

  const engineers = useMemo(() => {
    const rows = (engineersQ.data ?? []) as UserListRow[];
    return rows
      .filter((u) => u.role === 'engineer' && u.isActive)
      .map((u) => ({ id: u.id, name: u.fullName }));
  }, [engineersQ.data]);

  const scheduledTickets = (scheduleQ.data ?? []) as ScheduledTicket[];

  if (me.isLoading) {
    return <div className="text-muted-foreground p-8 text-center text-sm">Загрузка…</div>;
  }

  if (!isStaff) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-lg border p-4 text-sm">
          Раздел доступен только директору и диспетчеру.
        </div>
      </div>
    );
  }

  const today = new Date();
  const isCurrentWeek =
    weekStart.getTime() === getMondayOfWeek(today).getTime();

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <CalendarDays className="h-3.5 w-3.5" />
            Расписание
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">График инженеров</h1>
          <p className="text-muted-foreground text-sm">
            Перетащите заявку из левой панели на нужный слот, чтобы поставить её в график.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w, -7))}
            className="bg-secondary hover:bg-muted inline-flex h-8 w-8 items-center justify-center rounded-md text-sm transition"
            aria-label="Предыдущая неделя"
            title="Предыдущая неделя"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-foreground min-w-[200px] text-center text-sm font-medium tabular-nums">
            {formatWeekRange(weekStart)}
          </span>
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w, 7))}
            className="bg-secondary hover:bg-muted inline-flex h-8 w-8 items-center justify-center rounded-md text-sm transition"
            aria-label="Следующая неделя"
            title="Следующая неделя"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(getMondayOfWeek(new Date()))}
            disabled={isCurrentWeek}
            className={cn(
              'inline-flex h-8 items-center rounded-md px-3 text-xs font-medium transition',
              isCurrentWeek
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            Сегодня
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)]">
          <UnscheduledTicketsList
            onTicketClick={(id) => navigate(`/tickets/${id}`)}
          />
        </aside>

        <section className="min-w-0">
          {scheduleQ.isLoading || engineersQ.isLoading ? (
            <div className="text-muted-foreground bg-card rounded-lg border p-8 text-center text-sm">
              Загрузка…
            </div>
          ) : scheduleQ.error ? (
            <div className="text-destructive bg-destructive/10 border-destructive/30 rounded-lg border p-4 text-sm">
              Ошибка: {scheduleQ.error.message}
            </div>
          ) : (
            <WeekScheduleCalendar
              weekStart={weekStart}
              engineers={engineers}
              scheduledTickets={scheduledTickets}
              onSchedule={(input) => scheduleMut.mutate(input)}
              onUnschedule={(ticketId) => unscheduleMut.mutate({ ticketId })}
              onTicketClick={(ticketId) => navigate(`/tickets/${ticketId}`)}
            />
          )}
        </section>
      </div>

      {toast && (
        <div className="bg-destructive/10 border-destructive/30 text-destructive fixed bottom-4 right-4 z-50 rounded-md border px-3 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
