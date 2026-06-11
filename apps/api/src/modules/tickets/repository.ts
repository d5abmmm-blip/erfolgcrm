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
  ilike,
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
import { uuidv7 } from 'uuidv7';
import {
  clients,
  assets,
  contracts,
  users,
  tickets,
  ticketEvents,
  withTenantTx,
  type Db,
  type TicketEventPayload,
} from '@erfolg/db';
import { TicketNotFoundError } from '../../lib/errors';

type Tx = PgTransaction<never, never, never>;
import type {
  TicketStatus,
  TicketSource,
  IntakeMethod,
  TicketPriority,
  RepairType,
  TicketEventType,
} from '@erfolg/shared';

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
}

const PAGE_SIZE_DEFAULT = 25;
const TICKET_COUNTER_KIND = 'ticket';

export interface ListTicketsOpts {
  search?: string;
  statuses?: TicketStatus[];
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
  if (opts.statuses && opts.statuses.length > 0) {
    filters.push(inArray(tickets.status, opts.statuses));
  }
  if (opts.engineerId) filters.push(eq(tickets.assignedEngineerId, opts.engineerId));
  if (opts.clientId) filters.push(eq(tickets.clientId, opts.clientId));
  if (opts.contractId) filters.push(eq(tickets.contractId, opts.contractId));
  if (opts.scheduled === true) filters.push(isNotNull(tickets.scheduledStartAt));
  if (opts.scheduled === false) filters.push(isNull(tickets.scheduledStartAt));
  if (opts.search) {
    const q = `%${opts.search.trim()}%`;
    filters.push(
      or(
        ilike(tickets.ticketNumber, q),
        ilike(tickets.symptom, q),
        ilike(clients.displayName, q),
        ilike(assets.model, q),
      ) as SQL,
    );
  }
  return filters.length ? and(...filters) : undefined;
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
      })
      .from(tickets)
      .leftJoin(clients, eq(tickets.clientId, clients.id))
      .leftJoin(assets, eq(tickets.assetId, assets.id))
      .leftJoin(users, eq(tickets.assignedEngineerId, users.id))
      .where(whereClause)
      .orderBy(desc(tickets.receivedAt))
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
      .where(eq(tickets.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      clientDisplayName: row.clientDisplayName ?? '',
    };
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
        or(
          ilike(tickets.ticketNumber, query),
          ilike(clients.displayName, query),
          ilike(assets.model, query),
          ilike(assets.serialNumber, query),
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
        priority: input.priority ?? 'normal',
        status: 'received',
        symptom: input.symptom ?? null,
        notes: input.notes ?? null,
        assignedDispatcherId: input.assignedDispatcherId ?? null,
        assignedEngineerId: input.assignedEngineerId ?? null,
        slaTargetAt: input.slaTargetAt ?? null,
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
      .where(eq(tickets.id, ticketId))
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

export async function recordPrintEvent(
  db: Db,
  tenantId: string,
  userId: string | null,
  ticketId: string,
  documentKind: 'intake_act' | 'invoice' | 'work_act',
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const exists = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
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
    .where(eq(tickets.id, input.ticketId))
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
    .where(eq(tickets.id, input.ticketId))
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
