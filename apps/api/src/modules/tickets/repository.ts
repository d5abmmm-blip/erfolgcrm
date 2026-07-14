/**
 * Repository для tickets / ticket_events. Чистые DB-функции без бизнес-логики.
 *
 * Бизнес-инвариант: каждое значимое изменение заявки (status, priority,
 * assignment, sla) автоматически порождает ticket_event. Реализовано в
 * updateTicketWithEvents / changeStatus — в одной транзакции с UPDATE.
 *
 * Сквозная нумерация (ticket_number) обеспечивается через tenant_counters
 * UPSERT ... RETURNING last_value (атомарно).
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import {
  clients,
  assets,
  contracts,
  users,
  tickets,
  ticketEvents,
  workOrders,
  invoices,
  payments,
  withTenantTx,
  type Db,
  type TicketEventPayload,
} from '@erfolg/db';
import { TicketNotFoundError } from '../../lib/errors';
import { ruIlike } from '../../lib/ru-search';

type Tx = PgTransaction<never, never, never>;
import type {
  TicketStatus,
  TicketSource,
  IntakeMethod,
  TicketPriority,
  RepairType,
  TicketEventType,
  TicketBlockedReason,
} from '@erfolg/shared';
import { computeSlaTargetAt } from '@erfolg/shared';

export interface TicketListItem {
  id: string;
  ticketNumber: string;
  status: TicketStatus;
  priority: TicketPriority;
  repairType: RepairType;
  clientId: string;
  clientDisplayName: string;
  assetId: string | null;
  assetModel: string | null;
  assetSerialNumber: string | null;
  assignedEngineerId: string | null;
  assignedEngineerName: string | null;
  slaTargetAt: Date | null;
  deadlineAt: Date | null;
  receivedAt: Date;
  createdAt: Date;
  /** Фича A — флаг «Ждём запчасть» (для бейджа в списке/канбане). */
  waitingForPart: boolean;
  /**
   * Полных суток без активности на момент запроса. «Активность» = максимум из
   * tickets.received_at и времени последнего ticket_event (та же семантика, что у
   * AI-инструмента list_aged_tickets — бейдж «Висит N дн.» и ответ ИИ не расходятся).
   * Берём received_at, а не updated_at: служебные апдейты строки (напр. отметка
   * ready_notified_at без события) не должны ложно сбрасывать счётчик простоя.
   * Для закрытых/отменённых заявок не несёт смысла — бейдж их игнорирует на клиенте.
   */
  idleDays: number;
}

export interface TicketDetailDto extends TicketListItem {
  barcode: string;
  source: TicketSource;
  intakeMethod: IntakeMethod;
  contactId: string | null;
  contractId: string | null;
  contractNumber: string | null;
  symptom: string | null;
  notes: string | null;
  assignedDispatcherId: string | null;
  assignedDispatcherName: string | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  /** Stage 11 — поля расписания. */
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  estimatedMinutes: number | null;
  /** Фича A — заметка к флагу «Ждём запчасть» (что именно ждём). */
  waitingForPartNote: string | null;
  /** Доска — структурная причина простоя и когда он начался. */
  blockedReason: TicketBlockedReason | null;
  blockedSince: Date | null;
}

export interface TicketEventDto {
  id: string;
  type: TicketEventType;
  userId: string | null;
  userFullName: string | null;
  payload: TicketEventPayload;
  createdAt: Date;
}

export interface CreateTicketInput {
  clientId: string;
  assetId?: string | null;
  contactId?: string | null;
  contractId?: string | null;
  source?: TicketSource;
  intakeMethod?: IntakeMethod;
  repairType?: RepairType;
  priority?: TicketPriority;
  symptom?: string | null;
  notes?: string | null;
  assignedDispatcherId?: string | null;
  assignedEngineerId?: string | null;
  slaTargetAt?: Date | null;
  deadlineAt?: Date | null;
}

export interface UpdateTicketInput {
  clientId?: string;
  assetId?: string | null;
  contactId?: string | null;
  contractId?: string | null;
  source?: TicketSource;
  intakeMethod?: IntakeMethod;
  repairType?: RepairType;
  priority?: TicketPriority;
  symptom?: string | null;
  notes?: string | null;
  assignedDispatcherId?: string | null;
  assignedEngineerId?: string | null;
  slaTargetAt?: Date | null;
  deadlineAt?: Date | null;
  /** Фича A — флаг «Ждём запчасть» и заметка к нему. */
  waitingForPart?: boolean;
  waitingForPartNote?: string | null;
}

const PAGE_SIZE_DEFAULT = 25;
const TICKET_COUNTER_KIND = 'ticket';

/**
 * Порядок выдачи списка заявок.
 *   'received' — по дате приёма (свежие сверху). Историческое поведение, дефолт:
 *                нужен там, где список читают как хронологию (карточка договора,
 *                «похожие случаи»).
 *   'priority' — сначала срочность (urgent → high → normal → low), внутри — свежие
 *                сверху. Для рабочих очередей: список заявок, канбан, незапланированные.
 * Сортировка по enum ticket_priority опирается на порядок значений в самом enum
 * ('low','normal','high','urgent'), поэтому DESC даёт срочные первыми.
 */
export type TicketListSort = 'received' | 'priority';

export interface ListTicketsOpts {
  search?: string;
  statuses?: TicketStatus[];
  /** Фильтр по приоритету (напр. «только срочные» = ['urgent']). Пустой/undefined — без фильтра. */
  priorities?: TicketPriority[];
  engineerId?: string;
  clientId?: string;
  contractId?: string;
  /**
   * Stage 11 — фильтр по наличию расписания.
   *   true  → только запланированные (scheduled_start_at IS NOT NULL)
   *   false → только незапланированные (scheduled_start_at IS NULL)
   *   undefined → без фильтра.
   */
  scheduled?: boolean;
  /** Фича A — только заявки с флагом «Ждём запчасть». */
  waitingForPart?: boolean;
  /** Порядок выдачи. По умолчанию 'received' — прежнее поведение. */
  sort?: TicketListSort;
  page?: number;
  pageSize?: number;
}

/** Атомарный INC сквозного счётчика для (tenant, kind, year). */
export async function nextTicketNumber(
  tx: Tx,
  tenantId: string,
  year: number,
): Promise<string> {
  const result = await tx.execute(sql`
    INSERT INTO tenant_counters (tenant_id, kind, year, last_value)
    VALUES (${tenantId}::uuid, ${TICKET_COUNTER_KIND}, ${year}, 1)
    ON CONFLICT (tenant_id, kind, year)
      DO UPDATE SET last_value = tenant_counters.last_value + 1,
                    updated_at = now()
    RETURNING last_value
  `);
  const rows = result as unknown as Array<{ last_value: number }>;
  const value = rows[0]?.last_value;
  if (typeof value !== 'number') {
    throw new Error('nextTicketNumber: counter UPSERT returned no value');
  }
  return `T-${year}-${String(value).padStart(6, '0')}`;
}

/** Уникальный barcode формата T<33-hex>. Длина 33, влезает в varchar(64). */
export function generateBarcode(): string {
  return `T${uuidv7().replace(/-/g, '').toUpperCase()}`;
}

/** Хелпер: построение WHERE для listTickets. Вынесен чтобы не раздувать функцию. */
function buildListFilters(opts: ListTicketsOpts): SQL | undefined {
  const filters: SQL[] = [];
  // Мягко удалённые заявки (deleted_at) не показываем никогда.
  filters.push(isNull(tickets.deletedAt));
  if (opts.statuses && opts.statuses.length > 0) {
    filters.push(inArray(tickets.status, opts.statuses));
  }
  if (opts.priorities && opts.priorities.length > 0) {
    filters.push(inArray(tickets.priority, opts.priorities));
  }
  if (opts.engineerId) filters.push(eq(tickets.assignedEngineerId, opts.engineerId));
  if (opts.clientId) filters.push(eq(tickets.clientId, opts.clientId));
  if (opts.contractId) filters.push(eq(tickets.contractId, opts.contractId));
  if (opts.scheduled === true) filters.push(isNotNull(tickets.scheduledStartAt));
  if (opts.scheduled === false) filters.push(isNull(tickets.scheduledStartAt));
  if (opts.waitingForPart === true) filters.push(eq(tickets.waitingForPart, true));
  if (opts.search) {
    const q = `%${opts.search.trim()}%`;
    filters.push(
      or(
        ruIlike(tickets.ticketNumber, q),
        ruIlike(tickets.symptom, q),
        ruIlike(clients.displayName, q),
        ruIlike(assets.model, q),
      ) as SQL,
    );
  }
  return filters.length ? and(...filters) : undefined;
}

/**
 * Хелпер: ORDER BY для listTickets.
 *
 * ВАЖНО — уникальный последний ключ (id). Пагинация делает отдельный SELECT на каждую
 * страницу (LIMIT/OFFSET). Если ключ сортировки не уникален, Postgres НЕ обязан выдавать
 * строки-«близнецы» в одном и том же порядке на разных страницах: строка может попасть
 * на две страницы сразу, а другая — не попасть никуда. У нас это не теория: импорт из
 * WinServisePro проставил всем ~6000 архивным заявкам priority='normal' и дату БЕЗ времени,
 * т.е. тысячи строк совпадают по (priority, received_at). Раньше порядок нечаянно держался
 * на индексе (tenant_id, received_at); сортировка по приоритету этот индекс не использует.
 * Поэтому добавляем desc(id) — id это uuidv7 (монотонный), так что он же корректно доломает
 * тай-брейк «кто новее».
 *
 * ВАЖНО — завершённые вниз (только в режиме 'priority'). Список заявок по умолчанию
 * показывает ВСЕ статусы. Без этого условия закрытая срочная заявка вечно обгоняла бы
 * открытую обычную, и первая страница очереди со временем забилась бы архивом.
 * Очередь — про открытую работу. При фильтре «только закрытые» слагаемое константно и ни на
 * что не влияет.
 */
function buildListOrder(sort: TicketListSort | undefined): SQL[] {
  if (sort !== 'priority') {
    return [desc(tickets.receivedAt), desc(tickets.id)];
  }
  return [
    asc(sql`(${tickets.status} in ('closed', 'cancelled'))`),
    desc(tickets.priority),
    desc(tickets.receivedAt),
    desc(tickets.id),
  ];
}

export async function listTickets(
  db: Db,
  tenantId: string,
  opts: ListTicketsOpts = {},
): Promise<{ items: TicketListItem[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? PAGE_SIZE_DEFAULT));
  const offset = (page - 1) * pageSize;
  const whereClause = buildListFilters(opts);

  return withTenantTx(db, tenantId, async (tx) => {
    const items = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        status: tickets.status,
        priority: tickets.priority,
        repairType: tickets.repairType,
        clientId: tickets.clientId,
        clientDisplayName: clients.displayName,
        assetId: tickets.assetId,
        assetModel: assets.model,
        assetSerialNumber: assets.serialNumber,
        assignedEngineerId: tickets.assignedEngineerId,
        assignedEngineerName: users.fullName,
        slaTargetAt: tickets.slaTargetAt,
        deadlineAt: tickets.deadlineAt,
        receivedAt: tickets.receivedAt,
        createdAt: tickets.createdAt,
        waitingForPart: tickets.waitingForPart,
        // Простой в полных сутках: max(received_at, последнее ticket_event.created_at).
        // Та же «последняя активность», что в ai-assistant/read-queries (list_aged_tickets):
        // received_at (а не updated_at), иначе служебные апдейты строки сбрасывали бы бейдж.
        idleDays: sql<number>`floor(extract(epoch from (now() - greatest(
          ${tickets.receivedAt},
          coalesce(
            (select max(te.created_at) from ${ticketEvents} te where te.ticket_id = ${tickets.id}),
            ${tickets.receivedAt}
          )
        ))) / 86400)::int`,
      })
      .from(tickets)
      .leftJoin(clients, eq(tickets.clientId, clients.id))
      .leftJoin(assets, eq(tickets.assetId, assets.id))
      .leftJoin(users, eq(tickets.assignedEngineerId, users.id))
      .where(whereClause)
      .orderBy(...buildListOrder(opts.sort))
      .limit(pageSize)
      .offset(offset);

    const totalRow = await tx
      .select({ value: count() })
      .from(tickets)
      .leftJoin(clients, eq(tickets.clientId, clients.id))
      .leftJoin(assets, eq(tickets.assetId, assets.id))
      .where(whereClause);

    return {
      items: items.map((r) => ({
        ...r,
        clientDisplayName: r.clientDisplayName ?? '',
      })),
      total: Number(totalRow[0]?.value ?? 0),
    };
  });
}

export async function getTicket(
  db: Db,
  tenantId: string,
  id: string,
): Promise<TicketDetailDto | null> {
  // LEFT JOIN на users дважды через alias (engineer + dispatcher) и contracts —
  // быстрее коррелированных подзапросов на больших таблицах.
  const engineerUser = alias(users, 'engineer_user');
  const dispatcherUser = alias(users, 'dispatcher_user');
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        status: tickets.status,
        priority: tickets.priority,
        repairType: tickets.repairType,
        clientId: tickets.clientId,
        clientDisplayName: clients.displayName,
        assetId: tickets.assetId,
        assetModel: assets.model,
        assetSerialNumber: assets.serialNumber,
        assignedEngineerId: tickets.assignedEngineerId,
        assignedEngineerName: engineerUser.fullName,
        assignedDispatcherId: tickets.assignedDispatcherId,
        assignedDispatcherName: dispatcherUser.fullName,
        slaTargetAt: tickets.slaTargetAt,
        deadlineAt: tickets.deadlineAt,
        receivedAt: tickets.receivedAt,
        createdAt: tickets.createdAt,
        barcode: tickets.barcode,
        source: tickets.source,
        intakeMethod: tickets.intakeMethod,
        contactId: tickets.contactId,
        contractId: tickets.contractId,
        contractNumber: contracts.contractNumber,
        symptom: tickets.symptom,
        notes: tickets.notes,
        closedAt: tickets.closedAt,
        cancelledAt: tickets.cancelledAt,
        cancelReason: tickets.cancelReason,
        scheduledStartAt: tickets.scheduledStartAt,
        scheduledEndAt: tickets.scheduledEndAt,
        estimatedMinutes: tickets.estimatedMinutes,
        waitingForPart: tickets.waitingForPart,
        waitingForPartNote: tickets.waitingForPartNote,
        blockedReason: tickets.blockedReason,
        blockedSince: tickets.blockedSince,
        // То же определение «простоя», что и в listTickets / list_aged_tickets
        // (базовая дата — received_at, а не updated_at).
        idleDays: sql<number>`floor(extract(epoch from (now() - greatest(
          ${tickets.receivedAt},
          coalesce(
            (select max(te.created_at) from ${ticketEvents} te where te.ticket_id = ${tickets.id}),
            ${tickets.receivedAt}
          )
        ))) / 86400)::int`,
      })
      .from(tickets)
      .leftJoin(clients, eq(tickets.clientId, clients.id))
      .leftJoin(assets, eq(tickets.assetId, assets.id))
      .leftJoin(engineerUser, eq(engineerUser.id, tickets.assignedEngineerId))
      .leftJoin(dispatcherUser, eq(dispatcherUser.id, tickets.assignedDispatcherId))
      .leftJoin(
        contracts,
        and(eq(contracts.id, tickets.contractId), isNull(contracts.deletedAt)),
      )
      // Удалённая заявка не открывается — это же чтение гейтит update/changeStatus/reopen.
      .where(and(eq(tickets.id, id), isNull(tickets.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      clientDisplayName: row.clientDisplayName ?? '',
    };
  });
}

/* ─────────── Фича №7 «Лист ожидания запчастей» ─────────── */

export interface PartWaitingItem {
  id: string;
  ticketNumber: string;
  clientDisplayName: string;
  assetModel: string | null;
  /** Что за деталь ждём (заметка к флагу «Ждём запчасть»). */
  waitingForPartNote: string | null;
  assignedEngineerName: string | null;
  blockedSince: Date | null;
  /** Полных суток простоя из-за детали — от blocked_since (фолбэк received_at). */
  daysWaiting: number;
}

/** Заявки в работе (не закрытые/отменённые) — среди них ищем ждущие деталь. */
const PARTS_ACTIVE_STATUSES: TicketStatus[] = [
  'received',
  'diagnostics',
  'estimate',
  'approval',
  'in_progress',
  'act_pending',
];

/**
 * Фича №7 — активные заявки, стоящие из-за ожидания детали (waiting_for_part=true).
 * daysWaiting считается от blocked_since (когда встал; фолбэк на received_at для
 * старых записей). Сортировка: дольше всех — сверху. Клиент/техника/инженер — LEFT JOIN.
 */
export async function partsWaitingList(
  db: Db,
  tenantId: string,
): Promise<PartWaitingItem[]> {
  const engineerUser = alias(users, 'engineer_user');
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        clientDisplayName: clients.displayName,
        assetModel: assets.model,
        waitingForPartNote: tickets.waitingForPartNote,
        assignedEngineerName: engineerUser.fullName,
        blockedSince: tickets.blockedSince,
        daysWaiting: sql<number>`floor(extract(epoch from (now() - coalesce(${tickets.blockedSince}, ${tickets.receivedAt}))) / 86400)::int`,
      })
      .from(tickets)
      .leftJoin(clients, eq(tickets.clientId, clients.id))
      .leftJoin(assets, eq(tickets.assetId, assets.id))
      .leftJoin(engineerUser, eq(engineerUser.id, tickets.assignedEngineerId))
      .where(
        and(
          isNull(tickets.deletedAt),
          eq(tickets.waitingForPart, true),
          inArray(tickets.status, PARTS_ACTIVE_STATUSES),
        ),
      )
      .orderBy(asc(sql`coalesce(${tickets.blockedSince}, ${tickets.receivedAt})`));
    return rows.map((r) => ({ ...r, clientDisplayName: r.clientDisplayName ?? '' }));
  });
}

export async function searchTickets(
  db: Db,
  tenantId: string,
  q: string,
): Promise<
  Array<{
    id: string;
    ticketNumber: string;
    clientDisplayName: string;
    assetModel: string | null;
  }>
> {
  const query = `%${q.trim()}%`;
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        clientDisplayName: clients.displayName,
        assetModel: assets.model,
      })
      .from(tickets)
      .leftJoin(clients, eq(tickets.clientId, clients.id))
      .leftJoin(assets, eq(tickets.assetId, assets.id))
      .where(
        and(
          isNull(tickets.deletedAt),
          or(
            ruIlike(tickets.ticketNumber, query),
            ruIlike(clients.displayName, query),
            ruIlike(assets.model, query),
            ruIlike(assets.serialNumber, query),
          ),
        ),
      )
      .orderBy(desc(tickets.receivedAt))
      .limit(10);
    return rows.map((r) => ({ ...r, clientDisplayName: r.clientDisplayName ?? '' }));
  });
}

export async function listEvents(
  db: Db,
  tenantId: string,
  ticketId: string,
  limit = 200,
): Promise<TicketEventDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    return tx
      .select({
        id: ticketEvents.id,
        type: ticketEvents.type,
        userId: ticketEvents.userId,
        userFullName: users.fullName,
        payload: ticketEvents.payload,
        createdAt: ticketEvents.createdAt,
      })
      .from(ticketEvents)
      .leftJoin(users, eq(ticketEvents.userId, users.id))
      .where(eq(ticketEvents.ticketId, ticketId))
      .orderBy(desc(ticketEvents.createdAt))
      .limit(Math.max(1, Math.min(500, limit)));
  });
}

export async function createTicket(
  db: Db,
  tenantId: string,
  userId: string | null,
  input: CreateTicketInput,
): Promise<{ id: string; ticketNumber: string; barcode: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const now = new Date();
    const ticketNumber = await nextTicketNumber(tx, tenantId, now.getUTCFullYear());
    const barcode = generateBarcode();
    const priority = input.priority ?? 'normal';
    const inserted = await tx
      .insert(tickets)
      .values({
        tenantId,
        ticketNumber,
        barcode,
        clientId: input.clientId,
        assetId: input.assetId ?? null,
        contactId: input.contactId ?? null,
        contractId: input.contractId ?? null,
        source: input.source ?? 'call',
        intakeMethod: input.intakeMethod ?? 'brought_in',
        repairType: input.repairType ?? 'paid',
        priority,
        status: 'received',
        symptom: input.symptom ?? null,
        notes: input.notes ?? null,
        assignedDispatcherId: input.assignedDispatcherId ?? null,
        assignedEngineerId: input.assignedEngineerId ?? null,
        // Авто-SLA: если срок реакции не задан явно — вычисляем по приоритету от момента приёма.
        slaTargetAt: input.slaTargetAt ?? computeSlaTargetAt(now, priority),
        deadlineAt: input.deadlineAt ?? null,
        receivedAt: now,
      })
      .returning({ id: tickets.id });
    const newId = inserted[0]?.id;
    if (!newId) throw new Error('createTicket: insert returned nothing');
    await tx.insert(ticketEvents).values({
      tenantId,
      ticketId: newId,
      userId,
      type: 'created',
      payload: {},
    });
    return { id: newId, ticketNumber, barcode };
  });
}

/** Внутренний хелпер: набор патч-полей для Drizzle UPDATE (только заданные ключи). */
function buildUpdateSet(patch: UpdateTicketInput): Record<string, unknown> {
  const setObj: Record<string, unknown> = {};
  const keys: (keyof UpdateTicketInput)[] = [
    'clientId',
    'assetId',
    'contactId',
    'contractId',
    'source',
    'intakeMethod',
    'repairType',
    'priority',
    'symptom',
    'notes',
    'assignedDispatcherId',
    'assignedEngineerId',
    'slaTargetAt',
    'deadlineAt',
    'waitingForPart',
    'waitingForPartNote',
  ];
  for (const k of keys) {
    if (patch[k] !== undefined) setObj[k] = patch[k];
  }
  return setObj;
}

/** Внутренний хелпер: сравнить before/after и вернуть массив событий для записи. */
function diffEvents(
  before: typeof tickets.$inferSelect,
  patch: UpdateTicketInput,
): Array<{ type: TicketEventType; payload: TicketEventPayload }> {
  const events: Array<{ type: TicketEventType; payload: TicketEventPayload }> = [];
  if (patch.priority !== undefined && patch.priority !== before.priority) {
    events.push({
      type: 'priority_change',
      payload: { from: before.priority, to: patch.priority },
    });
  }
  if (
    patch.assignedEngineerId !== undefined &&
    patch.assignedEngineerId !== before.assignedEngineerId
  ) {
    events.push({
      type: 'assignment_change',
      payload: { role: 'engineer', from: before.assignedEngineerId, to: patch.assignedEngineerId },
    });
  }
  if (
    patch.assignedDispatcherId !== undefined &&
    patch.assignedDispatcherId !== before.assignedDispatcherId
  ) {
    events.push({
      type: 'assignment_change',
      payload: {
        role: 'dispatcher',
        from: before.assignedDispatcherId,
        to: patch.assignedDispatcherId,
      },
    });
  }
  const slaChanged =
    (patch.slaTargetAt !== undefined &&
      (patch.slaTargetAt?.getTime() ?? null) !== (before.slaTargetAt?.getTime() ?? null)) ||
    (patch.deadlineAt !== undefined &&
      (patch.deadlineAt?.getTime() ?? null) !== (before.deadlineAt?.getTime() ?? null));
  if (slaChanged) {
    events.push({
      type: 'sla_change',
      payload: {
        from: { sla: before.slaTargetAt, deadline: before.deadlineAt },
        to: {
          sla: patch.slaTargetAt !== undefined ? patch.slaTargetAt : before.slaTargetAt,
          deadline: patch.deadlineAt !== undefined ? patch.deadlineAt : before.deadlineAt,
        },
      },
    });
  }
  return events;
}

export async function updateTicket(
  db: Db,
  tenantId: string,
  userId: string | null,
  id: string,
  patch: UpdateTicketInput,
): Promise<{ events: Array<{ type: TicketEventType; payload: TicketEventPayload }> }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const current = await tx.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    const before = current[0];
    if (!before) return { events: [] };

    const setObj = buildUpdateSet(patch);
    // Авто-SLA: при смене приоритета пересчитываем срок реакции от момента приёма
    // (если явный slaTargetAt не задан). Обновляем только поле — отдельное событие
    // sla_change не пишем: смена приоритета в хронологии уже объясняет сдвиг срока.
    if (
      patch.priority !== undefined &&
      patch.priority !== before.priority &&
      patch.slaTargetAt === undefined
    ) {
      setObj.slaTargetAt = computeSlaTargetAt(before.receivedAt, patch.priority);
    }
    if (Object.keys(setObj).length === 0) return { events: [] };
    await tx.update(tickets).set(setObj).where(eq(tickets.id, id));

    const events = diffEvents(before, patch);
    if (events.length > 0) {
      await tx.insert(ticketEvents).values(
        events.map((e) => ({
          tenantId,
          ticketId: id,
          userId,
          type: e.type,
          payload: e.payload,
        })),
      );
    }
    return { events };
  });
}

export async function changeStatus(
  db: Db,
  tenantId: string,
  userId: string | null,
  id: string,
  newStatus: TicketStatus,
  cancelReason?: string | null,
): Promise<{ id: string; from: TicketStatus; to: TicketStatus }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    const before = rows[0];
    if (!before) throw new Error('Ticket not found');

    const now = new Date();
    const setObj: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'closed') {
      setObj.closedAt = now;
      setObj.cancelledAt = null;
      setObj.cancelReason = null;
    } else if (newStatus === 'cancelled') {
      setObj.cancelledAt = now;
      setObj.closedAt = null;
      setObj.cancelReason = cancelReason ?? null;
    } else {
      // reopen / переход в активный статус
      setObj.closedAt = null;
      setObj.cancelledAt = null;
      setObj.cancelReason = null;
    }
    await tx.update(tickets).set(setObj).where(eq(tickets.id, id));

    await tx.insert(ticketEvents).values({
      tenantId,
      ticketId: id,
      userId,
      type: 'status_change',
      payload: { from: before.status, to: newStatus },
    });
    return { id, from: before.status, to: newStatus };
  });
}

export async function addNote(
  db: Db,
  tenantId: string,
  userId: string | null,
  ticketId: string,
  comment: string,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const exists = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);
    if (!exists[0]) throw new Error('Ticket not found');
    const inserted = await tx
      .insert(ticketEvents)
      .values({
        tenantId,
        ticketId,
        userId,
        type: 'note',
        payload: { comment },
      })
      .returning({ id: ticketEvents.id });
    return { id: inserted[0]!.id };
  });
}

/**
 * Фича A — установить/снять флаг «Ждём запчасть» + заметку.
 * Запись в журнал делаем событием type='note' (не плодим новое значение enum
 * ticket_event_type — это потребовало бы ALTER TYPE и риска для живой схемы).
 * Идемпотентно: если флаг и заметка не меняются, событие не пишем.
 */
export async function setWaitingForPart(
  db: Db,
  tenantId: string,
  userId: string | null,
  ticketId: string,
  waiting: boolean,
  note: string | null,
): Promise<{ id: string; waitingForPart: boolean; waitingForPartNote: string | null }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: tickets.id,
        waitingForPart: tickets.waitingForPart,
        waitingForPartNote: tickets.waitingForPartNote,
        blockedReason: tickets.blockedReason,
        blockedSince: tickets.blockedSince,
      })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);
    const before = rows[0];
    if (!before) throw new TicketNotFoundError();

    // Заметку храним только когда флаг включён; при снятии чистим её.
    const nextNote = waiting ? (note?.trim() || null) : null;
    const changed =
      before.waitingForPart !== waiting || (before.waitingForPartNote ?? null) !== nextNote;

    if (changed) {
      // Синхронизируем структурную причину простоя (инвариант доски:
      // waiting_for_part=true ⟺ blocked_reason='waiting_part').
      const setObj: Record<string, unknown> = {
        waitingForPart: waiting,
        waitingForPartNote: nextNote,
      };
      if (waiting) {
        setObj.blockedReason = 'waiting_part';
        setObj.blockedSince =
          before.blockedReason === 'waiting_part' && before.blockedSince
            ? before.blockedSince
            : new Date();
      } else if (before.blockedReason === 'waiting_part') {
        setObj.blockedReason = null;
        setObj.blockedSince = null;
      }
      await tx.update(tickets).set(setObj).where(eq(tickets.id, ticketId));

      const comment = waiting
        ? `Ждём запчасть${nextNote ? `: ${nextNote}` : ''}`
        : 'Запчасть получена — ожидание снято';
      await tx.insert(ticketEvents).values({
        tenantId,
        ticketId,
        userId,
        type: 'note',
        payload: { comment },
      });
    }

    return { id: ticketId, waitingForPart: waiting, waitingForPartNote: nextNote };
  });
}

/* ─────────── Фича №3 «Трек как посылку» — публичный токен ─────────── */

/**
 * Вернуть публичный трек-токен заявки, создав его при первом обращении (идемпотентно).
 * Токен — случайный UUIDv4 (непредсказуемый bearer, ~122 бита энтропии). Заявка чужого
 * tenant не видна (RLS в withTenantTx) → NOT_FOUND. Повторный вызов отдаёт тот же токен.
 */
export async function getOrCreateTrackToken(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<string> {
  const candidate = randomUUID();
  return withTenantTx(db, tenantId, async (tx) => {
    // Атомарно, без окна гонки SELECT-then-UPDATE: COALESCE сохраняет уже выданный токен.
    // Два одновременных запроса по одной заявке сериализуются на row-lock — второй UPDATE
    // переоценит COALESCE против уже проставленного токена и оставит его, а не перезапишет.
    // Иначе один из двух разосланных клиенту линков оказался бы мёртвым.
    const rows = await tx
      .update(tickets)
      .set({ publicTrackToken: sql`coalesce(${tickets.publicTrackToken}, ${candidate}::uuid)` })
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .returning({ token: tickets.publicTrackToken });
    const token = rows[0]?.token;
    if (!token) throw new TicketNotFoundError();
    return token;
  });
}

/** Отозвать публичную ссылку (обнулить токен). Старая ссылка перестаёт работать. */
export async function revokeTrackToken(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);
    if (!row) throw new TicketNotFoundError();
    await tx.update(tickets).set({ publicTrackToken: null }).where(eq(tickets.id, ticketId));
  });
}

/** Денежный след заявки, блокирующий удаление. */
export interface TicketDeleteBlockers {
  /** Число внесённых оплат по заявке. */
  payments: number;
  /** Число выставленных (не-черновик) счетов. */
  issuedInvoices: number;
}

export type SoftDeleteTicketResult =
  | { status: 'not_found' }
  | { status: 'blocked'; blockers: TicketDeleteBlockers }
  | { status: 'deleted'; ticketNumber: string };

/**
 * Мягкое удаление заявки. Заявка получает deleted_at и исчезает из всех списков,
 * поиска, доски и отчётов (запросы фильтруют deleted_at IS NULL). Физически ничего
 * не стирается, касса и склад не трогаются — операция ОБРАТИМА.
 *
 * Защита целостности: если у заявки есть оплаты или выставленные счета (issued/
 * partially_paid/paid/overdue) — удаление запрещено (иначе скрытая заявка «унесла» бы
 * реальную выручку из кассы и отчётов). Такие заявки нужно отменять, а не удалять.
 *
 * Каскад в той же транзакции: наряд заявки и черновики её счетов тоже помечаются
 * deleted_at — чтобы не «висели» в отчётах/книге счетов без заявки.
 */
export async function softDeleteTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<SoftDeleteTicketResult> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [before] = await tx
      .select({ ticketNumber: tickets.ticketNumber })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);
    if (!before) return { status: 'not_found' };

    const [pay] = await tx
      .select({ n: count() })
      .from(payments)
      .where(eq(payments.ticketId, ticketId));
    const [inv] = await tx
      .select({ n: count() })
      .from(invoices)
      .where(
        and(
          eq(invoices.ticketId, ticketId),
          isNull(invoices.deletedAt),
          inArray(invoices.status, ['issued', 'partially_paid', 'paid', 'overdue']),
        ),
      );
    const blockers: TicketDeleteBlockers = {
      payments: Number(pay?.n ?? 0),
      issuedInvoices: Number(inv?.n ?? 0),
    };
    if (blockers.payments > 0 || blockers.issuedInvoices > 0) {
      return { status: 'blocked', blockers };
    }

    const now = new Date();
    await tx.update(tickets).set({ deletedAt: now }).where(eq(tickets.id, ticketId));
    // Наряд (1:1) — чтобы не попадал в отчёты/зарплату через join по work_orders.
    await tx
      .update(workOrders)
      .set({ deletedAt: now })
      .where(and(eq(workOrders.ticketId, ticketId), isNull(workOrders.deletedAt)));
    // Черновики счетов заявки — прячем из книги счетов (issued/paid уже отсеяны guard'ом).
    await tx
      .update(invoices)
      .set({ deletedAt: now })
      .where(
        and(
          eq(invoices.ticketId, ticketId),
          eq(invoices.status, 'draft'),
          isNull(invoices.deletedAt),
        ),
      );
    return { status: 'deleted', ticketNumber: before.ticketNumber };
  });
}

/** Русские подписи причин простоя (для события в журнале). Фронт имеет свою карту. */
export const BLOCKED_REASON_LABEL_RU: Record<TicketBlockedReason, string> = {
  waiting_part: 'ждём запчасть',
  waiting_client_approval: 'ждём согласование клиента',
  waiting_payment: 'ждём оплату',
  waiting_management_decision: 'ждём решение руководства',
  no_free_engineer: 'нет свободного инженера',
  waiting_delivery: 'ждём привоз / самовывоз техники',
  ready_for_pickup: 'готово — позвонить клиенту',
};

/**
 * Установить/снять структурную причину простоя. reason=null снимает простой.
 * Держит инвариант с флагом «ждём запчасть»: reason='waiting_part' ⟺ waiting_for_part=true.
 * blocked_since ставится при первом входе в простой и не сбрасывается при смене причины
 * (честный счётчик «стоит N дней»). Пишет событие note (не плодим enum). Идемпотентно.
 */
export async function setBlockedReason(
  db: Db,
  tenantId: string,
  userId: string | null,
  ticketId: string,
  reason: TicketBlockedReason | null,
  note: string | null,
): Promise<{
  id: string;
  blockedReason: TicketBlockedReason | null;
  blockedSince: Date | null;
  waitingForPart: boolean;
  waitingForPartNote: string | null;
}> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: tickets.id,
        blockedReason: tickets.blockedReason,
        blockedSince: tickets.blockedSince,
        waitingForPart: tickets.waitingForPart,
        waitingForPartNote: tickets.waitingForPartNote,
      })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);
    const before = rows[0];
    if (!before) throw new TicketNotFoundError();

    const trimmedNote = note?.trim() || null;
    const isPart = reason === 'waiting_part';
    const wasBlocked = before.blockedReason != null;
    const nextBlockedSince =
      reason == null ? null : wasBlocked && before.blockedSince ? before.blockedSince : new Date();
    const nextWaitingNote = isPart ? trimmedNote : null;

    const changed =
      (before.blockedReason ?? null) !== (reason ?? null) ||
      before.waitingForPart !== isPart ||
      (isPart && (before.waitingForPartNote ?? null) !== nextWaitingNote);

    if (changed) {
      await tx
        .update(tickets)
        .set({
          blockedReason: reason,
          blockedSince: nextBlockedSince,
          waitingForPart: isPart,
          waitingForPartNote: nextWaitingNote,
        })
        .where(eq(tickets.id, ticketId));

      const comment =
        reason == null
          ? 'Простой снят'
          : `Причина простоя: ${BLOCKED_REASON_LABEL_RU[reason]}${
              trimmedNote ? ` — ${trimmedNote}` : ''
            }`;
      await tx.insert(ticketEvents).values({
        tenantId,
        ticketId,
        userId,
        type: 'note',
        payload: { comment },
      });
    }

    return {
      id: ticketId,
      blockedReason: reason,
      blockedSince: nextBlockedSince,
      waitingForPart: isPart,
      waitingForPartNote: nextWaitingNote,
    };
  });
}

export async function recordPrintEvent(
  db: Db,
  tenantId: string,
  userId: string | null,
  ticketId: string,
  documentKind: 'intake_act' | 'invoice' | 'work_act' | 'defect_act' | 'tech_condition_act',
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const exists = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);
    if (!exists[0]) throw new Error('Ticket not found');
    const inserted = await tx
      .insert(ticketEvents)
      .values({
        tenantId,
        ticketId,
        userId,
        type: 'document_printed',
        payload: { documentKind },
      })
      .returning({ id: ticketEvents.id });
    return { id: inserted[0]!.id };
  });
}

export async function clientBelongsToTenant(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return rows.length > 0;
  });
}

/** Возвращает subtype юрлица или null (для individual / отсутствующего клиента). */
export async function clientSubtype(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<'commercial' | 'budget' | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ subtype: clients.subtype })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return rows[0]?.subtype ?? null;
  });
}

export async function assetBelongsToTenant(
  db: Db,
  tenantId: string,
  assetId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * Stage 10'.I — вернуть требуемую категорию аттестации для обслуживания asset'а
 * (NULL если не задана). Используется в проверке назначения инженера.
 */
export async function getAssetRequiredAttestation(
  db: Db,
  tenantId: string,
  assetId: string,
): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ category: assets.requiredAttestationCategory })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    return rows[0]?.category ?? null;
  });
}

export async function userBelongsToTenant(
  db: Db,
  tenantId: string,
  userId: string,
  role?: 'director' | 'dispatcher' | 'engineer',
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [eq(users.id, userId)];
    if (role) filters.push(eq(users.role, role));
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(...filters))
      .limit(1);
    return rows.length > 0;
  });
}

/* ──────────────────────── Stage 11: Schedule ──────────────────────── */

export interface ScheduleSnapshot {
  engineerId: string | null;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  estimatedMinutes: number | null;
}

export interface RepoScheduleInput {
  ticketId: string;
  engineerId: string;
  scheduledStartAt: Date;
  scheduledEndAt?: Date | null;
  estimatedMinutes?: number | null;
}

export interface RepoScheduleResult {
  ticketId: string;
  ticketNumber: string;
  before: ScheduleSnapshot;
  after: ScheduleSnapshot;
}

/**
 * Stage 11 — поставить заявку в график инженера. Атомарно (SELECT перед UPDATE
 * в одной tenant-tx). Возвращает before/after для audit-записи в service-слое.
 *
 * Бросает TicketNotFoundError если заявка не найдена в текущем tenant'е (RLS).
 */
export async function repoSchedule(
  tx: Tx,
  input: RepoScheduleInput,
): Promise<RepoScheduleResult> {
  const current = await tx
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      assignedEngineerId: tickets.assignedEngineerId,
      scheduledStartAt: tickets.scheduledStartAt,
      scheduledEndAt: tickets.scheduledEndAt,
      estimatedMinutes: tickets.estimatedMinutes,
    })
    .from(tickets)
    .where(and(eq(tickets.id, input.ticketId), isNull(tickets.deletedAt)))
    .limit(1);
  const before = current[0];
  if (!before) throw new TicketNotFoundError();

  const scheduledEnd = input.scheduledEndAt ?? null;
  const estimated = input.estimatedMinutes ?? null;

  await tx
    .update(tickets)
    .set({
      assignedEngineerId: input.engineerId,
      scheduledStartAt: input.scheduledStartAt,
      scheduledEndAt: scheduledEnd,
      estimatedMinutes: estimated,
    })
    .where(eq(tickets.id, input.ticketId));

  return {
    ticketId: input.ticketId,
    ticketNumber: before.ticketNumber,
    before: {
      engineerId: before.assignedEngineerId,
      scheduledStartAt: before.scheduledStartAt,
      scheduledEndAt: before.scheduledEndAt,
      estimatedMinutes: before.estimatedMinutes,
    },
    after: {
      engineerId: input.engineerId,
      scheduledStartAt: input.scheduledStartAt,
      scheduledEndAt: scheduledEnd,
      estimatedMinutes: estimated,
    },
  };
}

export interface RepoUnscheduleInput {
  ticketId: string;
}

export interface RepoUnscheduleResult {
  ticketId: string;
  ticketNumber: string;
  before: ScheduleSnapshot;
}

/**
 * Stage 11 — снять заявку с расписания. assigned_engineer_id остаётся (это другая
 * операция — просто не назначаем время). Бросает TicketNotFoundError если 0 rows.
 */
export async function repoUnschedule(
  tx: Tx,
  input: RepoUnscheduleInput,
): Promise<RepoUnscheduleResult> {
  const current = await tx
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      assignedEngineerId: tickets.assignedEngineerId,
      scheduledStartAt: tickets.scheduledStartAt,
      scheduledEndAt: tickets.scheduledEndAt,
      estimatedMinutes: tickets.estimatedMinutes,
    })
    .from(tickets)
    .where(and(eq(tickets.id, input.ticketId), isNull(tickets.deletedAt)))
    .limit(1);
  const before = current[0];
  if (!before) throw new TicketNotFoundError();

  await tx
    .update(tickets)
    .set({
      scheduledStartAt: null,
      scheduledEndAt: null,
      estimatedMinutes: null,
    })
    .where(eq(tickets.id, input.ticketId));

  return {
    ticketId: input.ticketId,
    ticketNumber: before.ticketNumber,
    before: {
      engineerId: before.assignedEngineerId,
      scheduledStartAt: before.scheduledStartAt,
      scheduledEndAt: before.scheduledEndAt,
      estimatedMinutes: before.estimatedMinutes,
    },
  };
}

export interface ScheduledTicketDto {
  id: string;
  ticketNumber: string;
  engineerId: string | null;
  engineerName: string | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date | null;
  estimatedMinutes: number | null;
  status: TicketStatus;
  priority: TicketPriority;
  clientName: string;
  symptom: string | null;
}

export interface RepoWeeklyScheduleInput {
  weekStart: Date;
  weekEnd: Date;
}

/**
 * Stage 11 — список тикетов с расписанием в окне [weekStart, weekEnd).
 * Полузакрытый интервал по соглашению (как в Postgres BETWEEN-WHERE-clauses).
 */
export async function repoWeeklySchedule(
  tx: Tx,
  input: RepoWeeklyScheduleInput,
): Promise<ScheduledTicketDto[]> {
  const rows = await tx
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      engineerId: tickets.assignedEngineerId,
      engineerName: users.fullName,
      scheduledStartAt: tickets.scheduledStartAt,
      scheduledEndAt: tickets.scheduledEndAt,
      estimatedMinutes: tickets.estimatedMinutes,
      status: tickets.status,
      priority: tickets.priority,
      clientName: clients.displayName,
      symptom: tickets.symptom,
    })
    .from(tickets)
    .leftJoin(clients, eq(tickets.clientId, clients.id))
    .leftJoin(users, eq(users.id, tickets.assignedEngineerId))
    .where(
      and(
        isNull(tickets.deletedAt),
        isNotNull(tickets.scheduledStartAt),
        gte(tickets.scheduledStartAt, input.weekStart),
        lt(tickets.scheduledStartAt, input.weekEnd),
      ),
    )
    .orderBy(asc(tickets.scheduledStartAt));

  return rows.map((r) => ({
    id: r.id,
    ticketNumber: r.ticketNumber,
    engineerId: r.engineerId,
    engineerName: r.engineerName,
    // start не может быть null здесь — фильтр isNotNull выше; sanity-fallback на now().
    scheduledStartAt: r.scheduledStartAt ?? new Date(0),
    scheduledEndAt: r.scheduledEndAt,
    estimatedMinutes: r.estimatedMinutes,
    status: r.status,
    priority: r.priority,
    clientName: r.clientName ?? '',
    symptom: r.symptom,
  }));
}

export interface RepoMyWeeklyScheduleInput extends RepoWeeklyScheduleInput {
  engineerId: string;
}

/**
 * Stage 11 — расписание текущего инженера (engineerId передаётся из ctx.session.userId).
 */
export async function repoMyWeeklySchedule(
  tx: Tx,
  input: RepoMyWeeklyScheduleInput,
): Promise<ScheduledTicketDto[]> {
  const rows = await tx
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      engineerId: tickets.assignedEngineerId,
      engineerName: users.fullName,
      scheduledStartAt: tickets.scheduledStartAt,
      scheduledEndAt: tickets.scheduledEndAt,
      estimatedMinutes: tickets.estimatedMinutes,
      status: tickets.status,
      priority: tickets.priority,
      clientName: clients.displayName,
      symptom: tickets.symptom,
    })
    .from(tickets)
    .leftJoin(clients, eq(tickets.clientId, clients.id))
    .leftJoin(users, eq(users.id, tickets.assignedEngineerId))
    .where(
      and(
        eq(tickets.assignedEngineerId, input.engineerId),
        isNull(tickets.deletedAt),
        isNotNull(tickets.scheduledStartAt),
        gte(tickets.scheduledStartAt, input.weekStart),
        lt(tickets.scheduledStartAt, input.weekEnd),
      ),
    )
    .orderBy(asc(tickets.scheduledStartAt));

  return rows.map((r) => ({
    id: r.id,
    ticketNumber: r.ticketNumber,
    engineerId: r.engineerId,
    engineerName: r.engineerName,
    scheduledStartAt: r.scheduledStartAt ?? new Date(0),
    scheduledEndAt: r.scheduledEndAt,
    estimatedMinutes: r.estimatedMinutes,
    status: r.status,
    priority: r.priority,
    clientName: r.clientName ?? '',
    symptom: r.symptom,
  }));
}

/* ──────────────────────── Доска «кто чем занят / почему стоит» ──────────────────────── */

/** Порог «жёлтого» (заявка ждёт/замедлилась) в днях. */
export const BOARD_WARN_DAYS = 3;
/**
 * Порог «красного» (застряла) в днях. Совпадает со STALE_TICKET_DAYS на фронте и
 * дефолтом AI-инструмента list_aged_tickets — чтобы сигналы не расходились.
 */
export const BOARD_STUCK_DAYS = 7;

export type TrafficLight = 'green' | 'yellow' | 'red';

/**
 * Эффективная причина простоя для доски. Явно хранимая (blocked_reason) имеет приоритет;
 * иначе выводим из статуса: estimate/approval → «ждём согласование клиента»,
 * act_pending → «готово — позвонить». Прочие активные статусы без причины → null (движется).
 */
export function deriveEffectiveBlockedReason(
  status: TicketStatus,
  blockedReason: TicketBlockedReason | null,
): TicketBlockedReason | null {
  if (blockedReason) return blockedReason;
  if (status === 'estimate' || status === 'approval') return 'waiting_client_approval';
  if (status === 'act_pending') return 'ready_for_pickup';
  return null;
}

/**
 * «Стоит N дней» — сколько заявка не двигается вперёд. Берём МАКСИМУМ из:
 *  - stalledDays: дней с последней СМЕНЫ СТАТУСА (прогресса). Заметки/классификация
 *    причины НЕ сбрасывают этот счётчик — простой считается честно;
 *  - дней с момента явно проставленного простоя (blocked_since).
 * Так классификация причины не «омолаживает» давно стоящую заявку.
 */
export function computeStuckDays(
  blockedSince: Date | null,
  stalledDays: number,
  nowMs: number,
): number {
  const blockedDays = blockedSince
    ? Math.max(0, Math.floor((nowMs - blockedSince.getTime()) / 86_400_000))
    : 0;
  return Math.max(stalledDays, blockedDays);
}

/**
 * Светофор карточки. act_pending (готово к выдаче) — зелёный (позитив, «позвонить»).
 * Красный — застряла (≥ STUCK) или просрочен SLA. Жёлтый — есть причина простоя или
 * замедлилась (≥ WARN). Иначе зелёный (движется).
 */
export function computeTrafficLight(
  status: TicketStatus,
  effectiveReason: TicketBlockedReason | null,
  stuckDays: number,
  slaTargetAt: Date | null,
  nowMs: number,
): TrafficLight {
  if (status === 'act_pending') return 'green';
  const slaOverdue = slaTargetAt != null && slaTargetAt.getTime() < nowMs;
  if (slaOverdue || stuckDays >= BOARD_STUCK_DAYS) return 'red';
  if (effectiveReason != null || stuckDays >= BOARD_WARN_DAYS) return 'yellow';
  return 'green';
}

export interface BoardTicketDto {
  id: string;
  ticketNumber: string;
  status: TicketStatus;
  priority: TicketPriority;
  clientId: string;
  clientDisplayName: string;
  assetId: string | null;
  assetModel: string | null;
  deviceType: string | null;
  assignedEngineerId: string | null;
  assignedEngineerName: string | null;
  assignedDispatcherId: string | null;
  assignedDispatcherName: string | null;
  waitingForPart: boolean;
  waitingForPartNote: string | null;
  /** Явно хранимая причина (может быть null, даже если карточка «жёлтая» по статусу). */
  blockedReason: TicketBlockedReason | null;
  /** Причина с учётом вывода из статуса — ключ колонки в виде «По причине». */
  effectiveReason: TicketBlockedReason | null;
  blockedSince: Date | null;
  slaTargetAt: Date | null;
  idleDays: number;
  stuckDays: number;
  light: TrafficLight;
}

const BOARD_ACTIVE_STATUSES: TicketStatus[] = [
  'received',
  'diagnostics',
  'estimate',
  'approval',
  'in_progress',
  'act_pending',
];

const LIGHT_RANK: Record<TrafficLight, number> = { red: 2, yellow: 1, green: 0 };

/**
 * Доска: все активные заявки (без closed/cancelled) одним запросом. Один payload
 * обслуживает оба вида (по инженеру / по причине) — группировка на клиенте.
 * Небольшой сервис — без пагинации.
 */
export async function boardTickets(db: Db, tenantId: string): Promise<BoardTicketDto[]> {
  const engineerUser = alias(users, 'board_engineer');
  const dispatcherUser = alias(users, 'board_dispatcher');
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        status: tickets.status,
        priority: tickets.priority,
        clientId: tickets.clientId,
        clientDisplayName: clients.displayName,
        assetId: tickets.assetId,
        assetModel: assets.model,
        deviceType: assets.deviceType,
        assignedEngineerId: tickets.assignedEngineerId,
        assignedEngineerName: engineerUser.fullName,
        assignedDispatcherId: tickets.assignedDispatcherId,
        assignedDispatcherName: dispatcherUser.fullName,
        waitingForPart: tickets.waitingForPart,
        waitingForPartNote: tickets.waitingForPartNote,
        blockedReason: tickets.blockedReason,
        blockedSince: tickets.blockedSince,
        slaTargetAt: tickets.slaTargetAt,
        idleDays: sql<number>`floor(extract(epoch from (now() - greatest(
          ${tickets.receivedAt},
          coalesce(
            (select max(te.created_at) from ${ticketEvents} te where te.ticket_id = ${tickets.id}),
            ${tickets.receivedAt}
          )
        ))) / 86400)::int`,
        // Дней без ПРОГРЕССА: от последней смены статуса (или регистрации). Заметки/
        // классификация причины сюда НЕ входят — счётчик простоя честный.
        stalledDays: sql<number>`floor(extract(epoch from (now() - greatest(
          ${tickets.receivedAt},
          coalesce(
            (select max(te.created_at) from ${ticketEvents} te
              where te.ticket_id = ${tickets.id} and te.type = 'status_change'),
            ${tickets.receivedAt}
          )
        ))) / 86400)::int`,
      })
      .from(tickets)
      .leftJoin(clients, eq(tickets.clientId, clients.id))
      .leftJoin(assets, eq(tickets.assetId, assets.id))
      .leftJoin(engineerUser, eq(engineerUser.id, tickets.assignedEngineerId))
      .leftJoin(dispatcherUser, eq(dispatcherUser.id, tickets.assignedDispatcherId))
      .where(and(isNull(tickets.deletedAt), inArray(tickets.status, BOARD_ACTIVE_STATUSES)));

    const nowMs = Date.now();
    const mapped: BoardTicketDto[] = rows.map((r) => {
      const effectiveReason = deriveEffectiveBlockedReason(r.status, r.blockedReason);
      const stuckDays = computeStuckDays(r.blockedSince, r.stalledDays, nowMs);
      const light = computeTrafficLight(r.status, effectiveReason, stuckDays, r.slaTargetAt, nowMs);
      return {
        ...r,
        clientDisplayName: r.clientDisplayName ?? '',
        effectiveReason,
        stuckDays,
        light,
      };
    });
    // Красные первыми, внутри — дольше стоящие выше.
    mapped.sort((a, b) => LIGHT_RANK[b.light] - LIGHT_RANK[a.light] || b.stuckDays - a.stuckDays);
    return mapped;
  });
}
