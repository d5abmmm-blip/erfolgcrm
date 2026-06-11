/**
 * Календарь компании — все события месяца с датами, собранные в одну ленту:
 *   • запланированные выезды/работы по заявкам (tickets.scheduled_start_at);
 *   • дедлайны открытых заявок (tickets.deadline_at);
 *   • плановое ТО (maintenance_schedules.next_due_at, только активные графики);
 *   • окончания договоров (contracts.valid_until);
 *   • окончания гарантий (warranties.end_date).
 *
 * Дни считаются в часовом поясе tenant'а (timestamptz-поля приводятся
 * AT TIME ZONE), чтобы событие «10 марта 23:30 МСК» не уезжало на 11-е.
 * Объёмы крошечные (single-company), поэтому 5 простых SELECT'ов в одной
 * транзакции — без оптимизаций.
 */
import { and, eq, isNotNull, isNull, ne, notInArray, sql } from 'drizzle-orm';
import {
  assets,
  calendarEvents,
  clients,
  contracts,
  maintenanceSchedules,
  tickets,
  warranties,
  withTenantTx,
  type Db,
} from '@erfolg/db';

export type CalendarEventType =
  | 'ticket'
  | 'ticket_deadline'
  | 'maintenance'
  | 'contract_end'
  | 'warranty_end'
  | 'custom';

export interface CalendarEvent {
  type: CalendarEventType;
  /** День события в часовом поясе tenant'а, YYYY-MM-DD. */
  date: string;
  /** Время HH:MM — у запланированных заявок и своих событий; иначе null. */
  time: string | null;
  /** id исходной сущности (для key на фронте). */
  id: string;
  title: string;
  subtitle: string | null;
  /** Куда ведёт клик. Для custom — '/calendar' (редактируется на месте). */
  href: string;
  /** Заметка — только у custom-событий (нужна для редактирования). */
  notes: string | null;
}

const MAINTENANCE_KIND_LABEL: Record<string, string> = {
  planned: 'Плановое ТО',
  urgent: 'Внеплановое ТО',
};

export async function listMonthEvents(
  db: Db,
  tenantId: string,
  timezone: string,
  year: number,
  month: number,
): Promise<CalendarEvent[]> {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const monthEnd = `${next.y}-${String(next.m).padStart(2, '0')}-01`;

  // День timestamptz-поля в поясе tenant'а (строкой YYYY-MM-DD).
  const dayOf = (col: unknown) =>
    sql<string>`to_char(${col} at time zone ${timezone}, 'YYYY-MM-DD')`;
  const timeOf = (col: unknown) =>
    sql<string>`to_char(${col} at time zone ${timezone}, 'HH24:MI')`;
  const inMonth = (col: unknown) =>
    sql`(${col} at time zone ${timezone})::date >= ${monthStart}::date
        and (${col} at time zone ${timezone})::date < ${monthEnd}::date`;

  return withTenantTx(db, tenantId, async (tx) => {
    const events: CalendarEvent[] = [];

    // 1. Запланированные заявки (выезды/работы). Отменённые не показываем.
    const scheduled = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        date: dayOf(tickets.scheduledStartAt),
        time: timeOf(tickets.scheduledStartAt),
        clientName: clients.displayName,
      })
      .from(tickets)
      .leftJoin(clients, eq(clients.id, tickets.clientId))
      .where(
        and(
          isNotNull(tickets.scheduledStartAt),
          ne(tickets.status, 'cancelled'),
          inMonth(tickets.scheduledStartAt),
        ),
      );
    for (const r of scheduled) {
      events.push({
        type: 'ticket',
        date: r.date,
        time: r.time,
        id: r.id,
        title: r.ticketNumber,
        subtitle: r.clientName ?? null,
        href: `/tickets/${r.id}`,
        notes: null,
      });
    }

    // 2. Дедлайны ещё не закрытых заявок.
    const deadlines = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        date: dayOf(tickets.deadlineAt),
        clientName: clients.displayName,
      })
      .from(tickets)
      .leftJoin(clients, eq(clients.id, tickets.clientId))
      .where(
        and(
          isNotNull(tickets.deadlineAt),
          notInArray(tickets.status, ['closed', 'cancelled']),
          inMonth(tickets.deadlineAt),
        ),
      );
    for (const r of deadlines) {
      events.push({
        type: 'ticket_deadline',
        date: r.date,
        time: null,
        id: r.id,
        title: `Дедлайн ${r.ticketNumber}`,
        subtitle: r.clientName ?? null,
        href: `/tickets/${r.id}`,
        notes: null,
      });
    }

    // 3. Плановое ТО по активным графикам.
    const maint = await tx
      .select({
        id: maintenanceSchedules.id,
        kind: maintenanceSchedules.kind,
        date: dayOf(maintenanceSchedules.nextDueAt),
        assetModel: assets.model,
      })
      .from(maintenanceSchedules)
      .leftJoin(assets, eq(assets.id, maintenanceSchedules.assetId))
      .where(
        and(
          eq(maintenanceSchedules.isActive, true),
          inMonth(maintenanceSchedules.nextDueAt),
        ),
      );
    for (const r of maint) {
      events.push({
        type: 'maintenance',
        date: r.date,
        time: null,
        id: r.id,
        title: r.assetModel ?? 'Техника',
        subtitle: MAINTENANCE_KIND_LABEL[r.kind] ?? 'ТО',
        href: '/maintenance',
        notes: null,
      });
    }

    // 4. Окончания договоров (кроме расторгнутых и удалённых).
    const contractEnds = await tx
      .select({
        id: contracts.id,
        contractNumber: contracts.contractNumber,
        date: sql<string>`to_char(${contracts.validUntil}, 'YYYY-MM-DD')`,
        clientName: clients.displayName,
      })
      .from(contracts)
      .leftJoin(clients, eq(clients.id, contracts.clientId))
      .where(
        and(
          isNull(contracts.deletedAt),
          ne(contracts.status, 'terminated'),
          isNotNull(contracts.validUntil),
          sql`${contracts.validUntil} >= ${monthStart}::date and ${contracts.validUntil} < ${monthEnd}::date`,
        ),
      );
    for (const r of contractEnds) {
      events.push({
        type: 'contract_end',
        date: r.date,
        time: null,
        id: r.id,
        title: `Договор № ${r.contractNumber}`,
        subtitle: r.clientName ? `истекает · ${r.clientName}` : 'истекает',
        href: `/contracts/${r.id}`,
        notes: null,
      });
    }

    // 5. Окончания гарантий (кроме аннулированных и удалённых).
    const warrantyEnds = await tx
      .select({
        id: warranties.id,
        date: sql<string>`to_char(${warranties.endDate}, 'YYYY-MM-DD')`,
        provider: warranties.provider,
        assetModel: assets.model,
      })
      .from(warranties)
      .leftJoin(assets, eq(assets.id, warranties.assetId))
      .where(
        and(
          isNull(warranties.deletedAt),
          eq(warranties.voided, false),
          sql`${warranties.endDate} >= ${monthStart}::date and ${warranties.endDate} < ${monthEnd}::date`,
        ),
      );
    for (const r of warrantyEnds) {
      events.push({
        type: 'warranty_end',
        date: r.date,
        time: null,
        id: r.id,
        title: r.assetModel ?? 'Техника',
        subtitle: r.provider ? `гарантия истекает · ${r.provider}` : 'гарантия истекает',
        href: '/warranties',
        notes: null,
      });
    }

    // 6. Свои события менеджеров (встречи, поставки, напоминания).
    const custom = await tx
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        date: sql<string>`to_char(${calendarEvents.eventDate}, 'YYYY-MM-DD')`,
        time: sql<string | null>`to_char(${calendarEvents.eventTime}, 'HH24:MI')`,
        notes: calendarEvents.notes,
      })
      .from(calendarEvents)
      .where(
        and(
          isNull(calendarEvents.deletedAt),
          sql`${calendarEvents.eventDate} >= ${monthStart}::date and ${calendarEvents.eventDate} < ${monthEnd}::date`,
        ),
      );
    for (const r of custom) {
      events.push({
        type: 'custom',
        date: r.date,
        time: r.time,
        id: r.id,
        title: r.title,
        subtitle: r.notes,
        href: '/calendar',
        notes: r.notes,
      });
    }

    // Сортировка: по дню, внутри дня — сначала со временем, затем по типу.
    events.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.time ?? '99:99').localeCompare(b.time ?? '99:99') ||
        a.type.localeCompare(b.type),
    );
    return events;
  });
}

/* ───────────── CRUD своих событий ───────────── */

export interface CalendarEventInput {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM или null — «весь день». */
  time: string | null;
  notes: string | null;
}

export async function createCalendarEvent(
  db: Db,
  tenantId: string,
  userId: string | null,
  input: CalendarEventInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(calendarEvents)
      .values({
        tenantId,
        title: input.title,
        eventDate: input.date,
        eventTime: input.time,
        notes: input.notes,
        createdByUserId: userId,
      })
      .returning({ id: calendarEvents.id });
    const row = rows[0];
    if (!row) throw new Error('createCalendarEvent: nothing returned');
    return row;
  });
}

export async function updateCalendarEvent(
  db: Db,
  tenantId: string,
  id: string,
  input: CalendarEventInput,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .update(calendarEvents)
      .set({
        title: input.title,
        eventDate: input.date,
        eventTime: input.time,
        notes: input.notes,
      })
      .where(and(eq(calendarEvents.id, id), isNull(calendarEvents.deletedAt)))
      .returning({ id: calendarEvents.id });
    return rows.length > 0;
  });
}

export async function deleteCalendarEvent(
  db: Db,
  tenantId: string,
  id: string,
): Promise<boolean> {
  // Soft delete — единый паттерн проекта (deleted_at).
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .update(calendarEvents)
      .set({ deletedAt: new Date() })
      .where(and(eq(calendarEvents.id, id), isNull(calendarEvents.deletedAt)))
      .returning({ id: calendarEvents.id });
    return rows.length > 0;
  });
}
