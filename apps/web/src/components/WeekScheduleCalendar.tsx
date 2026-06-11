/**
 * Stage 11 — Календарь расписания инженеров на один день недели.
 *
 * Один день — табы дней недели сверху. Колонки: время + по одной на инженера.
 * Слот 30 минут × SLOT_HEIGHT_PX. Рабочие часы 08:00–20:00.
 *
 * Тикет рисуется абсолютно позиционированным блоком внутри колонки инженера:
 *   top    = (startMinutes - 8*60) * (SLOT_HEIGHT_PX / 30)
 *   height = (estimatedMinutes ?? 60) * (SLOT_HEIGHT_PX / 30)
 *
 * Drag-and-drop — нативный HTML5 (как в TicketsKanbanPage).
 *  - dataTransfer key 'text/ticket-id' (формат UnscheduledTicketsList и
 *    наших же блоков, чтобы перемещать существующие записи).
 */
import { useState, type DragEvent } from 'react';
import type { TicketStatus, TicketPriority } from '@erfolg/shared';
import { cn } from '../lib/utils';
import { TICKET_STATUS_META, TICKET_PRIORITY_META } from '../lib/dictionaries';

export interface ScheduledTicket {
  id: string;
  ticketNumber: string;
  engineerId: string | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date | null;
  estimatedMinutes: number | null;
  status: TicketStatus;
  priority: TicketPriority;
  clientName: string;
  symptom: string | null;
}

interface Engineer {
  id: string;
  name: string;
}

interface Props {
  weekStart: Date;
  engineers: Engineer[];
  scheduledTickets: ScheduledTicket[];
  onSchedule: (input: {
    ticketId: string;
    engineerId: string;
    scheduledStartAt: Date;
    estimatedMinutes?: number;
  }) => void;
  onUnschedule: (ticketId: string) => void;
  onTicketClick: (ticketId: string) => void;
}

/** Высота слота в 30 минут, пикселей. Константа — задаёт визуальный масштаб. */
const SLOT_HEIGHT_PX = 32;
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const SLOT_MINUTES = 30;
const SLOTS_PER_DAY = ((DAY_END_HOUR - DAY_START_HOUR) * 60) / SLOT_MINUTES; // 24

const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatTimeLabel(slotIndex: number): string {
  const totalMinutes = DAY_START_HOUR * 60 + slotIndex * SLOT_MINUTES;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function pixelsPerMinute(): number {
  return SLOT_HEIGHT_PX / SLOT_MINUTES;
}

interface OverSlot {
  engineerId: string;
  slotIndex: number;
}

export function WeekScheduleCalendar({
  weekStart,
  engineers,
  scheduledTickets,
  onSchedule,
  onUnschedule,
  onTicketClick,
}: Props) {
  const [dayIndex, setDayIndex] = useState<number>(() => {
    // По умолчанию открыт сегодняшний день, если он в пределах недели; иначе понедельник.
    const today = new Date();
    for (let i = 0; i < 7; i += 1) {
      if (sameLocalDay(addDays(weekStart, i), today)) return i;
    }
    return 0;
  });
  const [overSlot, setOverSlot] = useState<OverSlot | null>(null);

  const day = addDays(weekStart, dayIndex);
  const ticketsForDay = scheduledTickets.filter((t) =>
    sameLocalDay(t.scheduledStartAt, day),
  );

  const engineerCols = engineers.slice(0, 9);

  const handleDrop = (engineerId: string, slotIndex: number, e: DragEvent) => {
    e.preventDefault();
    setOverSlot(null);
    const ticketId = e.dataTransfer.getData('text/ticket-id');
    if (!ticketId) return;

    const start = new Date(day);
    const totalMinutes = DAY_START_HOUR * 60 + slotIndex * SLOT_MINUTES;
    start.setHours(Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0);

    const existing = scheduledTickets.find((t) => t.id === ticketId);
    onSchedule({
      ticketId,
      engineerId,
      scheduledStartAt: start,
      estimatedMinutes: existing?.estimatedMinutes ?? undefined,
    });
  };

  return (
    <div className="bg-card flex flex-col gap-3 rounded-lg border p-3">
      <DayTabs weekStart={weekStart} value={dayIndex} onChange={setDayIndex} />

      {engineerCols.length === 0 ? (
        <div className="text-muted-foreground p-8 text-center text-sm">
          Нет активных инженеров. Добавьте их в «Настройки → Пользователи».
        </div>
      ) : (
        <div className="overflow-auto">
          <div
            className="relative grid"
            style={{
              gridTemplateColumns: `64px repeat(${engineerCols.length}, minmax(180px, 1fr))`,
            }}
          >
            {/* header row: empty + engineer names */}
            <div className="bg-card sticky top-0 z-20 border-b" />
            {engineerCols.map((eng) => (
              <div
                key={eng.id}
                className="bg-card text-foreground sticky top-0 z-20 truncate border-b border-l px-2 py-1.5 text-xs font-medium"
                title={eng.name}
              >
                {eng.name}
              </div>
            ))}

            {/* time column */}
            <div className="border-r">
              {Array.from({ length: SLOTS_PER_DAY }).map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    'text-muted-foreground flex items-start justify-end pr-2 text-[10px] tabular-nums',
                    i % 2 === 0 ? 'border-t' : 'border-t border-dashed border-border/50',
                  )}
                  style={{ height: SLOT_HEIGHT_PX }}
                >
                  {i % 2 === 0 ? formatTimeLabel(i) : ''}
                </div>
              ))}
            </div>

            {/* engineer columns */}
            {engineerCols.map((eng) => {
              const engTickets = ticketsForDay.filter((t) => t.engineerId === eng.id);
              return (
                <div key={eng.id} className="relative border-l">
                  {/* drop targets: один div на 30-минутный слот */}
                  {Array.from({ length: SLOTS_PER_DAY }).map((_, slotIndex) => {
                    const isOver =
                      overSlot?.engineerId === eng.id && overSlot.slotIndex === slotIndex;
                    return (
                      <div
                        key={slotIndex}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          setOverSlot({ engineerId: eng.id, slotIndex });
                        }}
                        onDragLeave={() =>
                          setOverSlot((cur) =>
                            cur?.engineerId === eng.id && cur.slotIndex === slotIndex
                              ? null
                              : cur,
                          )
                        }
                        onDrop={(e) => handleDrop(eng.id, slotIndex, e)}
                        className={cn(
                          'transition',
                          slotIndex % 2 === 0
                            ? 'border-t'
                            : 'border-t border-dashed border-border/50',
                          isOver && 'ring-2 ring-primary/30 bg-primary/5',
                        )}
                        style={{ height: SLOT_HEIGHT_PX }}
                      />
                    );
                  })}

                  {/* плашки тикетов поверх */}
                  {engTickets.map((t) => (
                    <ScheduledTicketBlock
                      key={t.id}
                      ticket={t}
                      onClick={() => onTicketClick(t.id)}
                      onUnschedule={() => onUnschedule(t.id)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Legend />
    </div>
  );
}

function DayTabs({
  weekStart,
  value,
  onChange,
}: {
  weekStart: Date;
  value: number;
  onChange: (i: number) => void;
}) {
  const today = new Date();
  return (
    <div className="bg-secondary inline-flex flex-wrap rounded-md p-0.5">
      {DAY_LABELS.map((label, i) => {
        const d = addDays(weekStart, i);
        const isToday = sameLocalDay(d, today);
        const isActive = value === i;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onChange(i)}
            className={cn(
              'inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span>{label}</span>
            <span className="tabular-nums">{d.getDate()}</span>
            {isToday && <span className="bg-primary inline-block h-1 w-1 rounded-full" />}
          </button>
        );
      })}
    </div>
  );
}

function ScheduledTicketBlock({
  ticket: t,
  onClick,
  onUnschedule,
}: {
  ticket: ScheduledTicket;
  onClick: () => void;
  onUnschedule: () => void;
}) {
  const ppm = pixelsPerMinute();
  const startMinutes =
    t.scheduledStartAt.getHours() * 60 + t.scheduledStartAt.getMinutes();
  const top = (startMinutes - DAY_START_HOUR * 60) * ppm;
  const durationMin = t.estimatedMinutes ?? 60;
  const height = Math.max(durationMin * ppm, SLOT_HEIGHT_PX);

  const status = TICKET_STATUS_META[t.status];
  const priority = TICKET_PRIORITY_META[t.priority];

  // цвет фона по статусу — мягкая заливка через variant
  const bgByVariant: Record<typeof status.variant, string> = {
    success: 'bg-success/15 border-success/30',
    warning: 'bg-warning/15 border-warning/30',
    danger: 'bg-destructive/10 border-destructive/30',
    info: 'bg-primary/10 border-primary/30',
    muted: 'bg-muted border-border',
  };

  const priorityStripe: Record<typeof priority.variant, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-destructive',
    info: 'bg-primary',
    muted: 'bg-muted-foreground/40',
  };

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/ticket-id', t.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onUnschedule();
        }
      }}
      title={`${t.ticketNumber} · ${t.clientName}${t.symptom ? `\n${t.symptom}` : ''}`}
      className={cn(
        'absolute left-1 right-1 z-10 cursor-grab overflow-hidden rounded-md border pl-2 pr-1.5 py-1 text-[11px] shadow-sm transition active:cursor-grabbing hover:ring-2 hover:ring-primary/30',
        bgByVariant[status.variant],
      )}
      style={{ top, height }}
    >
      <span
        className={cn(
          'absolute left-0 top-0 h-full w-1 rounded-l',
          priorityStripe[priority.variant],
        )}
        aria-hidden
      />
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono font-medium">{t.ticketNumber}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onUnschedule();
          }}
          className="text-muted-foreground hover:text-destructive shrink-0 leading-none"
          aria-label="Снять с расписания"
          title="Снять с расписания"
        >
          ×
        </button>
      </div>
      <div className="truncate" title={t.clientName}>
        {t.clientName}
      </div>
      {height >= SLOT_HEIGHT_PX * 2 && t.symptom ? (
        <div className="text-muted-foreground mt-0.5 line-clamp-2">{t.symptom}</div>
      ) : null}
    </div>
  );
}

function Legend() {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-[11px]">
      <span>Цвет фона — статус, левая полоса — приоритет</span>
      <span className="bg-primary/10 border-primary/30 inline-flex items-center gap-1 rounded border px-1.5 py-0.5">
        принята / в работе
      </span>
      <span className="bg-warning/15 border-warning/30 inline-flex items-center gap-1 rounded border px-1.5 py-0.5">
        в работе / согласование
      </span>
      <span className="bg-success/15 border-success/30 inline-flex items-center gap-1 rounded border px-1.5 py-0.5">
        закрыта
      </span>
    </div>
  );
}
