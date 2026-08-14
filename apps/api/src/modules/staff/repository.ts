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
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import {
  assets,
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

/* ══════════════════════ Вкладка «Работа»: что человек сделал ══════════════════════ */

export interface StaffWorkPeriod {
  /** Включительно. */
  from: Date;
  /** Исключительно — полуинтервал, чтобы последний день месяца не терялся. */
  to: Date;
}

export interface StaffWorkResult {
  from: string;
  to: string;
  totals: {
    /** Закрыто за период — ось по дате закрытия. */
    closedInPeriod: number;
    /** Сейчас незакрытых (без периода) — сходится со вкладкой «Сейчас». */
    openNow: number;
    /** Среднее время от заведения до закрытия, дни. null — закрытых нет. */
    avgCloseDays: number | null;
    /** Ещё столько заявок за период человек вёл вторым инженером. */
    helperInPeriod: number;
  };
  /** По неделям периода, включая пустые: без них график рвётся. */
  byWeek: Array<{ weekStart: string; closed: number }>;
  /** Срез ТЕКУЩИХ статусов заявок человека — без периода. */
  byStatus: Array<{ status: string; count: number }>;
  topClients: Array<{ clientId: string; name: string; closed: number }>;
  topDeviceTypes: Array<{ deviceType: string | null; closed: number }>;
  /** Последние закрытые за период — «5 штук и ссылка на все». */
  recent: Array<{
    id: string;
    ticketNumber: string;
    clientName: string | null;
    assetModel: string | null;
    closedAt: Date | null;
  }>;
}

/** Понедельники периода — ряд для графика, включая недели без единого закрытия. */
function weekStarts(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  // К понедельнику текущей недели: getUTCDay() 0 — воскресенье.
  const shift = (cursor.getUTCDay() + 6) % 7;
  cursor.setUTCDate(cursor.getUTCDate() - shift);
  while (cursor.getTime() < to.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

/**
 * История работы человека за период.
 *
 * Ось периода — ДАТА ЗАКРЫТИЯ (в отчётах она по дате заведения, и «закрыл за август»
 * там значит «заведена в августе» — на карточке это была бы чужая цифра).
 *
 * Отсечка STATS_SINCE тоже наложена на дату ЗАКРЫТИЯ (решение владельца 2026-08-15:
 * «считать по дате закрытия работы»). Смысл: заявка могла быть заведена ещё в старой
 * программе, но если инженер закрыл её уже в CRM — это его сегодняшний труд, и он
 * обязан быть виден. А то, что закрыли ДО запуска CRM, человеку не приписывается: в
 * перенесённых данных исполнителя фактически нет, там работали под одной учёткой.
 *
 * Ни одной суммы: карточку открывают и менеджеру, деньги по человеку живут отдельной
 * вкладкой под директором.
 */
export async function getStaffWork(
  db: Db,
  tenantId: string,
  userId: string,
  period: StaffWorkPeriod,
): Promise<StaffWorkResult> {
  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();

  return withTenantTx(db, tenantId, async (tx) => {
    const closedInPeriod = and(
      isNull(tickets.deletedAt),
      eq(tickets.assignedEngineerId, userId),
      // Пол по дате ЗАКРЫТИЯ, а не заведения — см. шапку функции.
      gte(tickets.closedAt, STATS_SINCE),
      eq(tickets.status, 'closed'),
      gte(tickets.closedAt, period.from),
      lt(tickets.closedAt, period.to),
    );

    const totalsRows = await tx
      .select({
        closed: sql<number>`COUNT(*)::int`,
        avgDays: sql<
          number | null
        >`ROUND((AVG(EXTRACT(EPOCH FROM (${tickets.closedAt} - ${tickets.createdAt})) / 86400))::numeric, 1)::float`,
      })
      .from(tickets)
      .where(closedInPeriod);

    const openRows = await tx
      .select({ open: sql<number>`COUNT(*)::int` })
      .from(tickets)
      .where(and(openInCrm(), eq(tickets.assignedEngineerId, userId)));

    // Вторым инженером — считаем отдельно и показываем строкой: в загрузку помощники
    // не входят (единственное определение «его работы» — ответственный), но молча
    // занижать число человеку нечестно.
    const helperRows = (await tx.execute(sql`
      SELECT COUNT(DISTINCT t.id)::int AS cnt
        FROM ticket_engineers te
        JOIN tickets t ON t.id = te.ticket_id
       WHERE te.user_id = ${userId}::uuid
         AND t.deleted_at IS NULL
         AND t.closed_at >= ${STATS_SINCE.toISOString()}::timestamptz
         AND t.status = 'closed'
         AND t.closed_at >= ${fromIso}::timestamptz
         AND t.closed_at <  ${toIso}::timestamptz
         AND t.assigned_engineer_id IS DISTINCT FROM ${userId}::uuid
    `)) as unknown as Array<{ cnt: number }>;

    const weekRows = await tx
      .select({
        weekStart: sql<string>`to_char(date_trunc('week', ${tickets.closedAt}), 'YYYY-MM-DD')`,
        closed: sql<number>`COUNT(*)::int`,
      })
      .from(tickets)
      .where(closedInPeriod)
      .groupBy(sql`date_trunc('week', ${tickets.closedAt})`);

    const statusRows = await tx
      .select({ status: tickets.status, count: sql<number>`COUNT(*)::int` })
      .from(tickets)
      // Срез «что на человеке сейчас» остаётся по дате ЗАВЕДЕНИЯ — ровно тот же набор,
      // что и на вкладке «Сейчас». Иначе два экрана давали бы разные ответы на один
      // вопрос «сколько на нём заявок», а незакрытый хвост переноса там показан
      // отдельным числом.
      .where(
        and(
          isNull(tickets.deletedAt),
          eq(tickets.assignedEngineerId, userId),
          gte(tickets.createdAt, STATS_SINCE),
        ),
      )
      .groupBy(tickets.status);

    const clientRows = await tx
      .select({
        clientId: tickets.clientId,
        name: clients.displayName,
        closed: sql<number>`COUNT(*)::int`,
      })
      .from(tickets)
      .leftJoin(clients, eq(clients.id, tickets.clientId))
      .where(closedInPeriod)
      .groupBy(tickets.clientId, clients.displayName)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(5);

    // Тип техники: свой из карточки, иначе — выведенный по архиву ремонтов (у всей
    // перенесённой техники поле пустое, а в архиве тип есть, см. assets/repository).
    const deviceRows = (await tx.execute(sql`
      WITH model_type AS (
        SELECT lower(btrim(device_model) COLLATE "ru-x-icu") AS model,
               min(btrim(device_type)) AS device_type
          FROM repair_archive
         WHERE device_model IS NOT NULL AND device_type IS NOT NULL
           AND btrim(device_type) <> ''
         GROUP BY 1
        HAVING count(DISTINCT lower(btrim(device_type) COLLATE "ru-x-icu")) = 1
      )
      SELECT COALESCE(NULLIF(btrim(a.device_type), ''), mt.device_type) AS device_type,
             COUNT(*)::int AS closed
        FROM tickets t
        LEFT JOIN assets a ON a.id = t.asset_id
        LEFT JOIN model_type mt ON mt.model = lower(btrim(a.model) COLLATE "ru-x-icu")
       WHERE t.deleted_at IS NULL
         AND t.assigned_engineer_id = ${userId}::uuid
         AND t.closed_at >= ${STATS_SINCE.toISOString()}::timestamptz
         AND t.status = 'closed'
         AND t.closed_at >= ${fromIso}::timestamptz
         AND t.closed_at <  ${toIso}::timestamptz
       GROUP BY 1
       ORDER BY 2 DESC
       LIMIT 5
    `)) as unknown as Array<{ device_type: string | null; closed: number }>;

    const recent = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        clientName: clients.displayName,
        assetModel: assets.model,
        closedAt: tickets.closedAt,
      })
      .from(tickets)
      .leftJoin(clients, eq(clients.id, tickets.clientId))
      .leftJoin(assets, eq(assets.id, tickets.assetId))
      .where(closedInPeriod)
      .orderBy(desc(tickets.closedAt))
      .limit(5);

    const byWeekMap = new Map(weekRows.map((r) => [r.weekStart, r.closed]));
    const byWeek = weekStarts(period.from, period.to).map((weekStart) => ({
      weekStart,
      closed: byWeekMap.get(weekStart) ?? 0,
    }));

    return {
      from: fromIso,
      to: toIso,
      totals: {
        closedInPeriod: totalsRows[0]?.closed ?? 0,
        openNow: openRows[0]?.open ?? 0,
        avgCloseDays: totalsRows[0]?.avgDays ?? null,
        helperInPeriod: helperRows[0]?.cnt ?? 0,
      },
      byWeek,
      byStatus: statusRows.map((r) => ({ status: r.status, count: r.count })),
      topClients: clientRows.map((r) => ({
        clientId: r.clientId,
        name: r.name ?? 'без клиента',
        closed: r.closed,
      })),
      topDeviceTypes: deviceRows.map((r) => ({ deviceType: r.device_type, closed: r.closed })),
      recent,
    };
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
