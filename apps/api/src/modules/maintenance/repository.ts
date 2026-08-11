/**
 * Repository для maintenance_schedules + maintenance_log.
 *
 * recordPerformed: атомарно INSERT log + UPDATE schedule.last_done_at и next_due_at
 * (= performed_at + interval_days * 86400000 ms). Если scheduleId не передан — только лог.
 */
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  assets,
  clients,
  maintenanceLog,
  maintenanceSchedules,
  withTenantTx,
  type Db,
} from '@erfolg/db';

/** Потолок выдачи списка графиков — страховка от «отдать всё разом». */
const LIST_LIMIT = 500;

export interface MaintenanceScheduleDto {
  id: string;
  assetId: string;
  assetModel: string | null;
  assetSerial: string | null;
  clientId: string | null;
  clientName: string | null;
  kind: 'planned' | 'urgent';
  intervalDays: number;
  lastDoneAt: Date | null;
  nextDueAt: Date;
  responsibleUserId: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MaintenanceLogDto {
  id: string;
  assetId: string;
  scheduleId: string | null;
  ticketId: string | null;
  performedAt: Date;
  performedByUserId: string | null;
  summary: string;
  notes: string | null;
  createdAt: Date;
}

export type ScheduleFilter = 'overdue' | 'due_soon' | 'all_active' | 'inactive';

const DUE_SOON_DAYS = 7;

function buildScheduleFilter(filter: ScheduleFilter | undefined, now: Date) {
  if (filter === 'overdue') {
    return and(eq(maintenanceSchedules.isActive, true), lte(maintenanceSchedules.nextDueAt, now));
  }
  if (filter === 'due_soon') {
    const horizon = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
    return and(
      eq(maintenanceSchedules.isActive, true),
      lte(maintenanceSchedules.nextDueAt, horizon),
    );
  }
  if (filter === 'inactive') return eq(maintenanceSchedules.isActive, false);
  return eq(maintenanceSchedules.isActive, true);
}

export async function listSchedules(
  db: Db,
  tenantId: string,
  opts: { filter?: ScheduleFilter; assetId?: string } = {},
): Promise<MaintenanceScheduleDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const conds = [buildScheduleFilter(opts.filter, new Date())];
    if (opts.assetId) conds.push(eq(maintenanceSchedules.assetId, opts.assetId));
    const rows = await tx
      .select({
        id: maintenanceSchedules.id,
        assetId: maintenanceSchedules.assetId,
        assetModel: assets.model,
        assetSerial: assets.serialNumber,
        // Без клиента список нельзя превратить в план выездов: по «модель +
        // серийник» при 5000 аппаратов непонятно, куда ехать.
        clientId: clients.id,
        clientName: clients.displayName,
        kind: maintenanceSchedules.kind,
        intervalDays: maintenanceSchedules.intervalDays,
        lastDoneAt: maintenanceSchedules.lastDoneAt,
        nextDueAt: maintenanceSchedules.nextDueAt,
        responsibleUserId: maintenanceSchedules.responsibleUserId,
        notes: maintenanceSchedules.notes,
        isActive: maintenanceSchedules.isActive,
        createdAt: maintenanceSchedules.createdAt,
        updatedAt: maintenanceSchedules.updatedAt,
      })
      .from(maintenanceSchedules)
      .leftJoin(assets, eq(maintenanceSchedules.assetId, assets.id))
      .leftJoin(clients, eq(clients.id, assets.ownerClientId))
      .where(and(...conds))
      .orderBy(asc(maintenanceSchedules.nextDueAt))
      // Предела не было вовсе. При массовом заведении графиков на 5000 единиц
      // техники страница потянула бы всё разом.
      .limit(LIST_LIMIT);
    return rows;
  });
}

/**
 * Гасит все графики ТО списанной техники.
 *
 * Чиним ИМЕННО так, а не фильтром по lifecycle_status в списке: график ТО
 * читают пять независимых запросов (список, две плитки дашборда, бейдж меню,
 * календарь), и все они уже смотрят на is_active. Погасив признак один раз,
 * мы убираем аппарат сразу отовсюду и не заводим шестое условие, от которого
 * цифры начнут расходиться ещё сильнее.
 *
 * Возврат техники из списания графики обратно НЕ включит — списание помечено
 * как необратимое действие директора, обратного перехода в системе нет.
 */
export async function deactivateSchedulesForAsset(
  db: Db,
  tenantId: string,
  assetId: string,
): Promise<number> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .update(maintenanceSchedules)
      .set({ isActive: false })
      .where(
        and(eq(maintenanceSchedules.assetId, assetId), eq(maintenanceSchedules.isActive, true)),
      )
      .returning({ id: maintenanceSchedules.id });
    return rows.length;
  });
}

export interface CreateScheduleInput {
  assetId: string;
  kind: 'planned' | 'urgent';
  intervalDays: number;
  responsibleUserId?: string | null;
  notes?: string | null;
  /** Если не передан — nextDueAt = now + intervalDays */
  startAt?: Date;
}

export async function createSchedule(
  db: Db,
  tenantId: string,
  input: CreateScheduleInput,
): Promise<{ id: string }> {
  const start = input.startAt ?? new Date();
  const next = new Date(start.getTime() + input.intervalDays * 24 * 60 * 60 * 1000);
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(maintenanceSchedules)
      .values({
        tenantId,
        assetId: input.assetId,
        kind: input.kind,
        intervalDays: input.intervalDays,
        lastDoneAt: null,
        nextDueAt: next,
        responsibleUserId: input.responsibleUserId ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: maintenanceSchedules.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error('createSchedule: insert returned nothing');
    return { id };
  });
}

export async function updateSchedule(
  db: Db,
  tenantId: string,
  scheduleId: string,
  patch: {
    kind?: 'planned' | 'urgent';
    intervalDays?: number;
    responsibleUserId?: string | null;
    notes?: string | null;
    isActive?: boolean;
  },
): Promise<void> {
  const setObj: Record<string, unknown> = {};
  if (patch.kind !== undefined) setObj.kind = patch.kind;
  if (patch.intervalDays !== undefined) setObj.intervalDays = patch.intervalDays;
  if (patch.responsibleUserId !== undefined) setObj.responsibleUserId = patch.responsibleUserId;
  if (patch.notes !== undefined) setObj.notes = patch.notes;
  if (patch.isActive !== undefined) setObj.isActive = patch.isActive;
  if (Object.keys(setObj).length === 0) return;
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(maintenanceSchedules)
      .set(setObj)
      .where(eq(maintenanceSchedules.id, scheduleId));
  });
}

export interface RecordPerformedInput {
  assetId: string;
  scheduleId?: string | null;
  ticketId?: string | null;
  performedAt: Date;
  performedByUserId: string | null;
  summary: string;
  notes?: string | null;
}

export async function recordPerformed(
  db: Db,
  tenantId: string,
  input: RecordPerformedInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(maintenanceLog)
      .values({
        tenantId,
        assetId: input.assetId,
        scheduleId: input.scheduleId ?? null,
        ticketId: input.ticketId ?? null,
        performedAt: input.performedAt,
        performedByUserId: input.performedByUserId,
        summary: input.summary,
        notes: input.notes ?? null,
      })
      .returning({ id: maintenanceLog.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error('recordPerformed: insert returned nothing');

    // Если есть привязка к графику — двигаем next_due_at.
    if (input.scheduleId) {
      const scheduleRows = await tx
        .select({
          intervalDays: maintenanceSchedules.intervalDays,
        })
        .from(maintenanceSchedules)
        .where(eq(maintenanceSchedules.id, input.scheduleId))
        .limit(1);
      const interval = scheduleRows[0]?.intervalDays;
      if (interval && interval > 0) {
        const next = new Date(input.performedAt.getTime() + interval * 24 * 60 * 60 * 1000);
        await tx
          .update(maintenanceSchedules)
          .set({ lastDoneAt: input.performedAt, nextDueAt: next })
          .where(
            and(
              eq(maintenanceSchedules.id, input.scheduleId),
              eq(maintenanceSchedules.tenantId, tenantId),
            ),
          );
      }
    }

    return { id };
  });
}

export async function listLog(
  db: Db,
  tenantId: string,
  opts: { assetId?: string; from?: Date; to?: Date; limit?: number },
): Promise<MaintenanceLogDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const conds = [];
    if (opts.assetId) conds.push(eq(maintenanceLog.assetId, opts.assetId));
    if (opts.from) conds.push(gte(maintenanceLog.performedAt, opts.from));
    if (opts.to) conds.push(lte(maintenanceLog.performedAt, opts.to));
    const rows = await tx
      .select({
        id: maintenanceLog.id,
        assetId: maintenanceLog.assetId,
        scheduleId: maintenanceLog.scheduleId,
        ticketId: maintenanceLog.ticketId,
        performedAt: maintenanceLog.performedAt,
        performedByUserId: maintenanceLog.performedByUserId,
        summary: maintenanceLog.summary,
        notes: maintenanceLog.notes,
        createdAt: maintenanceLog.createdAt,
      })
      .from(maintenanceLog)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(maintenanceLog.performedAt))
      .limit(opts.limit ?? 100);
    return rows;
  });
}

/** Проверка что asset принадлежит этому tenant'у. */
/** Ответственный по графику (для проверки «инженер отмечает только своё»). */
export async function scheduleResponsible(
  db: Db,
  tenantId: string,
  scheduleId: string,
): Promise<{ responsibleUserId: string | null } | null> {
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ responsibleUserId: maintenanceSchedules.responsibleUserId })
      .from(maintenanceSchedules)
      .where(eq(maintenanceSchedules.id, scheduleId))
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function assetExists(db: Db, tenantId: string, assetId: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ count: sql<string>`COUNT(*)` })
      .from(assets)
      .where(eq(assets.id, assetId));
    return Number(rows[0]?.count ?? '0') > 0;
  });
}
