/**
 * Repository warranties. Все запросы под withTenantTx (RLS на warranties FORCE).
 *
 * Статус НЕ хранится — вычисляется в SQL (voided/expired/expiring/active),
 * поэтому фильтр по статусу и stats всегда актуальны (в v1 хранимый статус протухал).
 * Клиент резолвится цепочкой warranties → assets.owner_client_id → clients.
 */
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { ruIlike } from '../../lib/ru-search';
import { assets, clients, warranties, withTenantTx, type Db } from '@erfolg/db';
import type { WarrantyStatus, WarrantyType } from '@erfolg/shared';

export interface WarrantyDto {
  id: string;
  assetId: string;
  assetModel: string;
  assetSerialNumber: string | null;
  clientId: string | null;
  clientDisplayName: string | null;
  type: WarrantyType;
  status: WarrantyStatus;
  startDate: string;
  endDate: string;
  voided: boolean;
  coverageDescription: string | null;
  provider: string | null;
  contractNumber: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWarrantyInput {
  assetId: string;
  type?: WarrantyType;
  startDate: string;
  endDate: string;
  coverageDescription?: string | null;
  provider?: string | null;
  contractNumber?: string | null;
  notes?: string | null;
}

export interface UpdateWarrantyPatch {
  type?: WarrantyType;
  startDate?: string;
  endDate?: string;
  voided?: boolean;
  coverageDescription?: string | null;
  provider?: string | null;
  contractNumber?: string | null;
  notes?: string | null;
}

export interface ListOpts {
  search?: string;
  status?: WarrantyStatus;
  type?: WarrantyType;
  assetId?: string;
  page?: number;
}

export interface WarrantyStats {
  total: number;
  active: number;
  expiring: number;
  expired: number;
  voided: number;
}

const PAGE_SIZE = 25;

/** SQL-выражение действующего статуса. Единая точка истины для select/filter/stats. */
const statusSql = sql<WarrantyStatus>`CASE
  WHEN ${warranties.voided} THEN 'voided'
  WHEN ${warranties.endDate} < CURRENT_DATE THEN 'expired'
  WHEN ${warranties.endDate} <= CURRENT_DATE + 30 THEN 'expiring'
  ELSE 'active'
END`;

/** Фильтр по вычисляемому статусу. */
function statusFilter(status: WarrantyStatus): SQL {
  switch (status) {
    case 'voided':
      return eq(warranties.voided, true);
    case 'expired':
      return and(
        eq(warranties.voided, false),
        sql`${warranties.endDate} < CURRENT_DATE`,
      ) as SQL;
    case 'expiring':
      return and(
        eq(warranties.voided, false),
        sql`${warranties.endDate} >= CURRENT_DATE AND ${warranties.endDate} <= CURRENT_DATE + 30`,
      ) as SQL;
    case 'active':
      return and(
        eq(warranties.voided, false),
        sql`${warranties.endDate} > CURRENT_DATE + 30`,
      ) as SQL;
  }
}

interface JoinedRow {
  warranty: typeof warranties.$inferSelect;
  status: WarrantyStatus;
  assetModel: string | null;
  assetSerialNumber: string | null;
  clientId: string | null;
  clientDisplayName: string | null;
}

function rowToDto(r: JoinedRow): WarrantyDto {
  const w = r.warranty;
  return {
    id: w.id,
    assetId: w.assetId,
    assetModel: r.assetModel ?? '—',
    assetSerialNumber: r.assetSerialNumber ?? null,
    clientId: r.clientId ?? null,
    clientDisplayName: r.clientDisplayName ?? null,
    type: w.type,
    status: r.status,
    startDate: w.startDate,
    endDate: w.endDate,
    voided: w.voided,
    coverageDescription: w.coverageDescription ?? null,
    provider: w.provider ?? null,
    contractNumber: w.contractNumber ?? null,
    notes: w.notes ?? null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

const joinedSelect = {
  warranty: warranties,
  status: statusSql,
  assetModel: assets.model,
  assetSerialNumber: assets.serialNumber,
  clientId: clients.id,
  clientDisplayName: clients.displayName,
};

export async function listWarranties(
  db: Db,
  tenantId: string,
  opts: ListOpts = {},
): Promise<{ items: WarrantyDto[]; total: number }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [isNull(warranties.deletedAt)];
    if (opts.status) filters.push(statusFilter(opts.status));
    if (opts.type) filters.push(eq(warranties.type, opts.type));
    if (opts.assetId) filters.push(eq(warranties.assetId, opts.assetId));
    if (opts.search) {
      const q = `%${opts.search.trim()}%`;
      filters.push(
        or(
          ruIlike(assets.model, q),
          ruIlike(assets.serialNumber, q),
          ruIlike(clients.displayName, q),
          ruIlike(warranties.provider, q),
          ruIlike(warranties.contractNumber, q),
        ) as SQL,
      );
    }
    const where = and(...filters);
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * PAGE_SIZE;

    const rows = await tx
      .select(joinedSelect)
      .from(warranties)
      .leftJoin(assets, eq(assets.id, warranties.assetId))
      .leftJoin(clients, eq(clients.id, assets.ownerClientId))
      .where(where)
      .orderBy(desc(warranties.endDate), desc(warranties.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset);

    const totalResult = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(warranties)
      .leftJoin(assets, eq(assets.id, warranties.assetId))
      .leftJoin(clients, eq(clients.id, assets.ownerClientId))
      .where(where);

    return {
      items: rows.map(rowToDto),
      total: totalResult[0]?.value ?? 0,
    };
  });
}

export async function getWarrantyById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<WarrantyDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select(joinedSelect)
      .from(warranties)
      .leftJoin(assets, eq(assets.id, warranties.assetId))
      .leftJoin(clients, eq(clients.id, assets.ownerClientId))
      .where(and(eq(warranties.id, id), isNull(warranties.deletedAt)))
      .limit(1);
    return rows[0] ? rowToDto(rows[0]) : null;
  });
}

/** Гарантии конкретной единицы техники (для карточки техники). */
export async function listByAsset(
  db: Db,
  tenantId: string,
  assetId: string,
): Promise<WarrantyDto[]> {
  const { items } = await listWarranties(db, tenantId, { assetId });
  return items;
}

export async function createWarranty(
  db: Db,
  tenantId: string,
  input: CreateWarrantyInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(warranties)
      .values({
        tenantId,
        assetId: input.assetId,
        type: input.type ?? 'manufacturer',
        startDate: input.startDate,
        endDate: input.endDate,
        coverageDescription: input.coverageDescription ?? null,
        provider: input.provider ?? null,
        contractNumber: input.contractNumber ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: warranties.id });
    const row = inserted[0];
    if (!row) throw new Error('createWarranty: nothing returned');
    return row;
  });
}

export async function updateWarranty(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateWarrantyPatch,
): Promise<WarrantyDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.startDate !== undefined) set.startDate = patch.startDate;
    if (patch.endDate !== undefined) set.endDate = patch.endDate;
    if (patch.voided !== undefined) set.voided = patch.voided;
    if (patch.coverageDescription !== undefined) set.coverageDescription = patch.coverageDescription;
    if (patch.provider !== undefined) set.provider = patch.provider;
    if (patch.contractNumber !== undefined) set.contractNumber = patch.contractNumber;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (Object.keys(set).length === 0) {
      return getWarrantyById(db, tenantId, id);
    }
    const updated = await tx
      .update(warranties)
      .set(set)
      .where(and(eq(warranties.id, id), isNull(warranties.deletedAt)))
      .returning({ id: warranties.id });
    if (!updated[0]) return null;
    return getWarrantyById(db, tenantId, id);
  });
}

export async function archiveWarranty(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(warranties)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(warranties.id, id), isNull(warranties.deletedAt)))
      .returning({ id: warranties.id });
    return updated.length > 0;
  });
}

/** Сводка по статусам — одним запросом с FILTER-агрегатами. */
export async function warrantyStats(db: Db, tenantId: string): Promise<WarrantyStats> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) FILTER (WHERE NOT ${warranties.voided} AND ${warranties.endDate} > CURRENT_DATE + 30)::int`,
        expiring: sql<number>`count(*) FILTER (WHERE NOT ${warranties.voided} AND ${warranties.endDate} >= CURRENT_DATE AND ${warranties.endDate} <= CURRENT_DATE + 30)::int`,
        expired: sql<number>`count(*) FILTER (WHERE NOT ${warranties.voided} AND ${warranties.endDate} < CURRENT_DATE)::int`,
        voided: sql<number>`count(*) FILTER (WHERE ${warranties.voided})::int`,
      })
      .from(warranties)
      .where(isNull(warranties.deletedAt));
    return rows[0] ?? { total: 0, active: 0, expiring: 0, expired: 0, voided: 0 };
  });
}

/** Проверка принадлежности техники тенанту (перед create). */
export async function assetExistsInTenant(
  db: Db,
  tenantId: string,
  assetId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), isNull(assets.deletedAt)))
      .limit(1);
    return rows.length > 0;
  });
}
