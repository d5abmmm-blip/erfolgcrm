/**
 * Календарь компании — месячная сетка всех событий с датами:
 * выезды по заявкам, дедлайны, плановое ТО, окончания договоров и гарантий.
 *
 * Доступ: директор + диспетчер (staffProcedure на API). Цвет = тип события,
 * в духе дизайн-языка «приборная панель»: голубой — работа, красный — дедлайн,
 * янтарный — ТО, оранжевый — договор, серый — гарантия.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { CalendarDays, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

type EventType = 'ticket' | 'ticket_deadline' | 'maintenance' | 'contract_end' | 'warranty_end';

interface CalendarEvent {
  type: EventType;
  date: string;
  time: string | null;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

const TYPE_META: Record<
  EventType,
  { label: string; dot: string; chip: string }
> = {
  ticket: {
    label: 'Выезд / работа по заявке',
    dot: 'bg-primary',
    chip: 'bg-primary/10 text-primary',
  },
  ticket_deadline: {
    label: 'Дедлайн заявки',
    dot: 'bg-destructive',
    chip: 'bg-destructive/10 text-destructive',
  },
  maintenance: {
    label: 'Плановое ТО',
    dot: 'bg-warning',
    chip: 'bg-warning/15 text-warning',
  },
  contract_end: {
    label: 'Договор истекает',
    dot: 'bg-accent',
    chip: 'bg-accent/15 text-accent',
  },
  warranty_end: {
    label: 'Гарантия истекает',
    dot: 'bg-muted-foreground/60',
    chip: 'bg-muted text-muted-foreground',
  },
};

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function todayStr(): string {
  const n = new Date();
  return toDateStr(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

export function CalendarPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [selected, setSelected] = useState<string | null>(todayStr());

  const eventsQ = trpc.calendar.month.useQuery({ year, month });

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of eventsQ.data ?? []) {
      const list = map.get(ev.date);
      if (list) list.push(ev);
      else map.set(ev.date, [ev]);
    }
    return map;
  }, [eventsQ.data]);

  const shiftMonth = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelected(null);
  };

  const goToday = () => {
    setYear(now.getFullYear());
    setMonth(now.getMonth() + 1);
    setSelected(todayStr());
  };

  // Сетка: недели с понедельника; хвосты соседних месяцев — пустые клетки.
  const firstOffset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const totalCells = Math.ceil((firstOffset + daysInMonth) / 7) * 7;
  const today = todayStr();

  const monthLabelRaw = new Date(year, month - 1, 1).toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric',
  });
  const monthLabel = monthLabelRaw.charAt(0).toUpperCase() + monthLabelRaw.slice(1);

  const selectedEvents = selected ? (eventsByDate.get(selected) ?? []) : [];

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold md:text-2xl">{monthLabel}</h2>
          <p className="text-muted-foreground text-sm">
            Выезды, дедлайны, ТО и окончания договоров — всё в одном месте
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label="Предыдущий месяц"
            className="hover:bg-muted grid h-8 w-8 place-items-center rounded-md border transition"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={goToday}
            className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium transition"
          >
            Сегодня
          </button>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label="Следующий месяц"
            className="hover:bg-muted grid h-8 w-8 place-items-center rounded-md border transition"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Легенда */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {(Object.keys(TYPE_META) as EventType[]).map((t) => (
          <span key={t} className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <span className={cn('h-2 w-2 rounded-full', TYPE_META[t].dot)} aria-hidden />
            {TYPE_META[t].label}
          </span>
        ))}
      </div>

      {eventsQ.error && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-lg border p-4 text-sm">
          Не удалось загрузить календарь: {eventsQ.error.message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Сетка месяца */}
        <section className="bg-card overflow-hidden rounded-xl border shadow-sm">
          <div className="grid grid-cols-7 border-b">
            {WEEKDAYS.map((d, i) => (
              <div
                key={d}
                className={cn(
                  'px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide',
                  i >= 5 ? 'text-destructive/70' : 'text-muted-foreground',
                )}
              >
                {d}
              </div>
            ))}
          </div>
          {eventsQ.isLoading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 p-16 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загружаем события…
            </div>
          ) : (
            <div className="grid grid-cols-7">
              {Array.from({ length: totalCells }, (_, i) => {
                const dayNum = i - firstOffset + 1;
                const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
                if (!inMonth) {
                  return <div key={i} className="bg-muted/30 min-h-24 border-b border-r" />;
                }
                const dateStr = toDateStr(year, month, dayNum);
                const dayEvents = eventsByDate.get(dateStr) ?? [];
                const isToday = dateStr === today;
                const isSelected = dateStr === selected;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelected(dateStr)}
                    className={cn(
                      'min-h-24 border-b border-r p-1.5 text-left align-top transition',
                      'hover:bg-primary/[0.05] focus-visible:bg-primary/[0.05] outline-none',
                      isSelected && 'ring-primary bg-primary/[0.06] ring-2 ring-inset',
                    )}
                  >
                    <div
                      className={cn(
                        'mb-1 grid h-6 w-6 place-items-center rounded-full text-xs font-medium',
                        isToday
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground',
                      )}
                    >
                      {dayNum}
                    </div>
                    <div className="space-y-0.5">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <div
                          key={`${ev.type}-${ev.id}`}
                          className={cn(
                            'flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] font-medium',
                            TYPE_META[ev.type].chip,
                          )}
                        >
                          <span
                            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TYPE_META[ev.type].dot)}
                            aria-hidden
                          />
                          {ev.time && <span className="tabular-nums">{ev.time}</span>}
                          <span className="truncate">{ev.title}</span>
                        </div>
                      ))}
                      {dayEvents.length > 3 && (
                        <div className="text-muted-foreground px-1 text-[11px]">
                          +{dayEvents.length - 3} ещё
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* События выбранного дня */}
        <aside className="bg-card h-fit rounded-xl border shadow-sm">
          <div className="flex items-center gap-2.5 border-b p-4">
            <span className="bg-primary/10 text-primary grid h-8 w-8 place-items-center rounded-lg">
              <CalendarDays className="h-4 w-4" />
            </span>
            <h3 className="font-semibold">
              {selected
                ? new Date(`${selected}T00:00:00`).toLocaleDateString('ru-RU', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })
                : 'Выберите день'}
            </h3>
          </div>
          {!selected ? (
            <div className="text-muted-foreground p-4 text-sm">
              Кликните по дню в сетке, чтобы посмотреть события.
            </div>
          ) : selectedEvents.length === 0 ? (
            <div className="text-muted-foreground p-4 text-sm">На этот день событий нет.</div>
          ) : (
            <div className="divide-y">
              {selectedEvents.map((ev) => (
                <Link
                  key={`${ev.type}-${ev.id}`}
                  href={ev.href}
                  className="hover:bg-primary/[0.05] flex items-start gap-2.5 p-3 transition"
                >
                  <span
                    className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', TYPE_META[ev.type].dot)}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {ev.time && <span className="tabular-nums">{ev.time} · </span>}
                      {ev.title}
                    </span>
                    {ev.subtitle && (
                      <span className="text-muted-foreground block truncate text-xs">
                        {ev.subtitle}
                      </span>
                    )}
                    <span className="text-muted-foreground/70 block text-[11px]">
                      {TYPE_META[ev.type].label}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
