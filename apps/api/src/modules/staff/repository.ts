/**
 * Repository раздела «Сотрудники»: кто чем занят прямо сейчас.
 *
 * Текущая загрузка считается ТОЛЬКО по заявкам, заведённым в CRM (см. STATS_SINCE).
 * Перенесённые из старой системы незакрытые заявки в загрузку не идут: их 58, из них
 * 41 висит на неактивном «Администраторе», а самая старая датирована 2015 годом —
 * это не работа, а хвост переноса. Но и молчать о них нельзя, поэтому считаем
 * отдельным числом и показываем отдельной строкой.
 *
 * Помощники (ticket_engineers) в загрузку НЕ входят — так же, как в отчётах загрузки
 * (решение принято при вводе нескольких инженеров на заявку). Считаем ответственного.
 */
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import {
  clients,
  tickets,
  userAvailability,
  userDeviceSkills,
  users,
  withTenantTx,
  type Db,
} from '@erfolg/db';
import { STATS_SINCE } from '../../lib/stats-since';

/** Статусы, которые означают «ещё в работе». Закрытые и отменённые — не загрузка. */
const OPEN_STATUSES = ['received', 'diagnostics', 'in_progress', 'act_pending'] as const;

export type StaffRole = 'director' | 'dispatcher' | 'engineer';

export interface StaffAway {
  kind: 'day_off' | 'vacation' | 'onsite';
  dateFrom: string;
  dateTo: string;
  note: string | null;
}

export interface StaffListRow {
  userId: string;
  fullName: string;
  username: string;
  position: string | null;
  role: StaffRole;
  isActive: boolean;
  /** Незакрытых заявок, заведённых в CRM. */
  openTickets: number;
  /** Из них с прошедшим сроком. */
  overdueTickets: number;
  /** Незакрытых заявок из архива прежней системы — справочно, в загрузку не идут. */
  archiveOpenTickets: number;
  /** Типы техники, которые человек обслуживает. */
  skills: string[];
  /** Отсутствие, покрывающее сегодняшний день, либо null. */
  awayToday: StaffAway | null;
}

export interface StaffOpenTicket {
  id: string;
  ticketNumber: string;
  status: string;
  clientName: string | null;
  createdAt: Date;
  deadlineAt: Date | null;
  isOverdue: boolean;
}

export interface StaffCard extends StaffListRow {
  /**
   * Телефон нужен по делу — менеджеру звонить инженеру. Почту и «последний вход»
   * сознательно НЕ отдаём: почта на карточке нигде не показывается (лишние ПДн в
   * ответе), а «последний вход» обновляется только при вводе пароля — сессия живёт
   * неделю и продлевается сама, поэтому человек может работать каждый день, а поле
   * покажет месячную давность. Такой показатель хуже, чем его отсутствие.
   */
  phone: string | null;
  /** Незакрытые заявки из CRM, по сроку вперёд. */
  openTicketList: StaffOpenTicket[];
  /** Все интервалы отсутствия от сегодняшнего дня и вперёд. */
  upcomingAway: StaffAway[];
}

/** Сегодня в таймзоне организации как YYYY-MM-DD (колонки дат — без времени). */
function todayIso(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Заявка «в работе» и заведена уже в CRM. */
function openInCrm() {
  return and(
    isNull(tickets.deletedAt),
    inArray(tickets.status, [...OPEN_STATUSES]),
    gte(tickets.createdAt, STATS_SINCE),
  );
}

/** Заявка «в работе», но перенесена из прежней системы. */
function openInArchive() {
  return and(
    isNull(tickets.deletedAt),
    inArray(tickets.status, [...OPEN_STATUSES]),
    lt(tickets.createdAt, STATS_SINCE),
  );
}

export async function listStaff(
  db: Db,
  tenantId: string,
  timezone: string,
  opts: { includeBlocked?: boolean } = {},
): Promise<StaffListRow[]> {
  const today = todayIso(timezone);

  return withTenantTx(db, tenantId, async (tx) => {
    const people = await tx
      .select({
        userId: users.id,
        fullName: users.fullName,
        username: users.username,
        position: users.position,
        role: users.role,
        isActive: users.isActive,
      })
      .from(users)
      .where(
        opts.includeBlocked
          ? isNull(users.deletedAt)
          : and(isNull(users.deletedAt), eq(users.isActive, true)),
      )
      .orderBy(asc(users.fullName));

    if (people.length === 0) return [];

    const load = await tx
      .select({
        userId: tickets.assignedEngineerId,
        open: sql<number>`COUNT(*)::int`,
        // now() считает сам Postgres: дату в параметр сырого фрагмента передать нельзя
        // (drizzle не выводит для неё тип и падает на ERR_INVALID_ARG_TYPE).
        overdue: sql<number>`COUNT(*) FILTER (WHERE ${tickets.deadlineAt} IS NOT NULL AND ${tickets.deadlineAt} < now())::int`,
      })
      .from(tickets)
      .where(openInCrm())
      .groupBy(tickets.assignedEngineerId);

    const archive = await tx
      .select({
        userId: tickets.assignedEngineerId,
        open: sql<number>`COUNT(*)::int`,
      })
      .from(tickets)
      .where(openInArchive())
      .groupBy(tickets.assignedEngineerId);

    const skills = await tx
      .select({ userId: userDeviceSkills.userId, deviceType: userDeviceSkills.deviceType })
      .from(userDeviceSkills)
      .orderBy(asc(userDeviceSkills.deviceType));

    const away = await tx
      .select({
        userId: userAvailability.userId,
        kind: userAvailability.kind,
        dateFrom: userAvailability.dateFrom,
        dateTo: userAvailability.dateTo,
        note: userAvailability.note,
      })
      .from(userAvailability)
      .where(and(lte(userAvailability.dateFrom, today), gte(userAvailability.dateTo, today)));

    const loadBy = new Map(load.filter((r) => r.userId).map((r) => [r.userId!, r]));
    const archiveBy = new Map(archive.filter((r) => r.userId).map((r) => [r.userId!, r.open]));
    const skillsBy = new Map<string, string[]>();
    for (const s of skills) {
      const list = skillsBy.get(s.userId) ?? [];
      list.push(s.deviceType);
      skillsBy.set(s.userId, list);
    }
    const awayBy = new Map(away.map((a) => [a.userId, a]));

    return people.map((p) => {
      const l = loadBy.get(p.userId);
      const a = awayBy.get(p.userId);
      return {
        ...p,
        openTickets: l?.open ?? 0,
        overdueTickets: l?.overdue ?? 0,
        archiveOpenTickets: archiveBy.get(p.userId) ?? 0,
        skills: skillsBy.get(p.userId) ?? [],
        awayToday: a
          ? { kind: a.kind, dateFrom: a.dateFrom, dateTo: a.dateTo, note: a.note }
          : null,
      };
    });
  });
}

export async function getStaffCard(
  db: Db,
  tenantId: string,
  timezone: string,
  userId: string,
): Promise<StaffCard | null> {
  const today = todayIso(timezone);
  const now = new Date();

  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        userId: users.id,
        fullName: users.fullName,
        username: users.username,
        position: users.position,
        role: users.role,
        isActive: users.isActive,
        phone: users.phone,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    const person = rows[0];
    if (!person) return null;

    const openList = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        status: tickets.status,
        clientName: clients.displayName,
        createdAt: tickets.createdAt,
        deadlineAt: tickets.deadlineAt,
      })
      .from(tickets)
      .leftJoin(clients, eq(clients.id, tickets.clientId))
      .where(and(openInCrm(), eq(tickets.assignedEngineerId, userId)))
      // Сначала те, у кого срок ближе; заявки без срока — в конец.
      .orderBy(sql`${tickets.deadlineAt} ASC NULLS LAST`, asc(tickets.createdAt))
      .limit(200);

    const archiveRows = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(tickets)
      .where(and(openInArchive(), eq(tickets.assignedEngineerId, userId)));

    const skillRows = await tx
      .select({ deviceType: userDeviceSkills.deviceType })
      .from(userDeviceSkills)
      .where(eq(userDeviceSkills.userId, userId))
      .orderBy(asc(userDeviceSkills.deviceType));

    const awayRows = await tx
      .select({
        kind: userAvailability.kind,
        dateFrom: userAvailability.dateFrom,
        dateTo: userAvailability.dateTo,
        note: userAvailability.note,
      })
      .from(userAvailability)
      .where(and(eq(userAvailability.userId, userId), gte(userAvailability.dateTo, today)))
      .orderBy(asc(userAvailability.dateFrom));

    const openTicketList: StaffOpenTicket[] = openList.map((t) => ({
      ...t,
      isOverdue: t.deadlineAt !== null && t.deadlineAt < now,
    }));

    return {
      ...person,
      openTickets: openTicketList.length,
      overdueTickets: openTicketList.filter((t) => t.isOverdue).length,
      archiveOpenTickets: archiveRows[0]?.count ?? 0,
      skills: skillRows.map((s) => s.deviceType),
      awayToday: awayRows.find((a) => a.dateFrom <= today && a.dateTo >= today) ?? null,
      openTicketList,
      upcomingAway: awayRows,
    };
  });
}
