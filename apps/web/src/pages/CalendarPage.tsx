/**
 * Календарь компании — месячная сетка всех событий с датами:
 * выезды по заявкам, дедлайны, плановое ТО, окончания договоров и гарантий.
 *
 * Доступ: директор + диспетчер (staffProcedure на API). Цвет = тип события,
 * в духе дизайн-языка «приборная панель»: голубой — работа, красный — дедлайн,
 * янтарный — ТО, оранжевый — договор, серый — гарантия.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, Pencil, Plus } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

type EventType =
  | 'ticket'
  | 'ticket_deadline'
  | 'maintenance'
  | 'contract_end'
  | 'warranty_end'
  | 'custom';

interface CalendarEvent {
  type: EventType;
  date: string;
  time: string | null;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  notes: string | null;
  remind: boolean;
}

type DialogState =
  | { mode: 'create'; date: string }
  | { mode: 'edit'; event: CalendarEvent }
  | null;

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
  custom: {
    label: 'Своё событие',
    dot: 'bg-success',
    chip: 'bg-success/12 text-success',
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
  const [dialog, setDialog] = useState<DialogState>(null);

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
            onClick={() => setDialog({ mode: 'create', date: selected ?? todayStr() })}
            className="bg-primary text-primary-foreground hover:bg-primary/90 mr-1 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Событие
          </button>
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
              {selectedEvents.map((ev) => {
                const inner = (
                  <>
                    <span
                      className={cn(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                        TYPE_META[ev.type].dot,
                      )}
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
                  </>
                );
                // Свои события редактируются на месте, остальные ведут в карточку.
                return ev.type === 'custom' ? (
                  <button
                    key={`${ev.type}-${ev.id}`}
                    type="button"
                    onClick={() => setDialog({ mode: 'edit', event: ev })}
                    className="hover:bg-primary/[0.05] flex w-full items-start gap-2.5 p-3 text-left transition"
                  >
                    {inner}
                    <Pencil className="text-muted-foreground/60 mt-1 h-3.5 w-3.5 shrink-0" />
                  </button>
                ) : (
                  <Link
                    key={`${ev.type}-${ev.id}`}
                    href={ev.href}
                    className="hover:bg-primary/[0.05] flex items-start gap-2.5 p-3 transition"
                  >
                    {inner}
                  </Link>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      {dialog && <EventDialog initial={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

/* ───────────── Диалог своего события ───────────── */

function EventDialog({
  initial,
  onClose,
}: {
  initial: NonNullable<DialogState>;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const isEdit = initial.mode === 'edit';
  const [title, setTitle] = useState(isEdit ? initial.event.title : '');
  const [date, setDate] = useState(isEdit ? initial.event.date : initial.date);
  const [time, setTime] = useState(isEdit ? (initial.event.time ?? '') : '');
  const [notes, setNotes] = useState(isEdit ? (initial.event.notes ?? '') : '');
  const [remind, setRemind] = useState(isEdit ? initial.event.remind : false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const done = async () => {
    await utils.calendar.month.invalidate();
    onClose();
  };
  const create = trpc.calendar.createEvent.useMutation({
    onSuccess: done,
    onError: (e) => setError(e.message),
  });
  const update = trpc.calendar.updateEvent.useMutation({
    onSuccess: done,
    onError: (e) => setError(e.message),
  });
  const remove = trpc.calendar.deleteEvent.useMutation({
    onSuccess: done,
    onError: (e) => setError(e.message),
  });
  const pending = create.isPending || update.isPending || remove.isPending;

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // Focus trap — как в ConfirmDialog (WAI-ARIA).
      if (e.key === 'Tab' && rootRef.current) {
        const focusables = rootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !rootRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !rootRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    setError(null);
    if (!title.trim()) {
      setError('Укажите название события');
      return;
    }
    const payload = {
      title: title.trim(),
      date,
      time: time || null,
      notes: notes.trim() || null,
      remind,
    };
    if (isEdit) update.mutate({ id: initial.event.id, ...payload });
    else create.mutate(payload);
  };

  const inputCls =
    'bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="event-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Закрыть диалог"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="bg-card relative z-10 w-full max-w-md space-y-4 rounded-lg border p-5 shadow-xl">
        <h3 id="event-dialog-title" className="flex items-center gap-2 text-base font-semibold">
          <span className="bg-success/12 text-success grid h-7 w-7 place-items-center rounded-lg">
            <CalendarDays className="h-4 w-4" />
          </span>
          {isEdit ? 'Изменить событие' : 'Новое событие'}
        </h3>

        <label className="block space-y-1">
          <span className="text-muted-foreground text-xs font-medium">Название</span>
          <input
            ref={titleRef}
            type="text"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Например: поставка запчастей, встреча с клиникой"
            className={inputCls}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-muted-foreground text-xs font-medium">Дата</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-muted-foreground text-xs font-medium">
              Время <span className="opacity-60">(необязательно)</span>
            </span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-muted-foreground text-xs font-medium">
            Заметка <span className="opacity-60">(необязательно)</span>
          </span>
          <textarea
            value={notes}
            rows={3}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Детали, адрес, телефон…"
            className={inputCls}
          />
        </label>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={remind}
            onChange={(e) => setRemind(e.target.checked)}
            className="accent-primary mt-0.5 h-4 w-4"
          />
          <span className="text-sm leading-tight">
            Напомнить накануне
            <span className="text-muted-foreground block text-xs">
              push-уведомление в 09:00 за день до события
            </span>
          </span>
        </label>

        {error && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {isEdit ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                remove.mutate({ id: initial.event.id });
              }}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50',
                confirmDelete
                  ? 'bg-destructive text-destructive-foreground border-destructive'
                  : 'text-destructive border-destructive/30 hover:bg-destructive/10',
              )}
            >
              {confirmDelete ? 'Точно удалить?' : 'Удалить'}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
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
              disabled={pending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {pending ? 'Сохраняю…' : isEdit ? 'Сохранить' : 'Создать'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
