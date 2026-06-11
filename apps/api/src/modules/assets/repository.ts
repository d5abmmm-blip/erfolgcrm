/**
 * Repository для assets/asset_events. Чистые DB-функции.
 *
 * Бизнес-инвариант «при изменении lifecycleStatus/ownerClientId/location
 * автоматически появляется asset_event» реализован в service.ts (одна транзакция).
 */
import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import {
  assetEvents,
  assets,
  clients,
  withTenantTx,
  type AssetEventPayload,
  type Db,
} from '@erfolg/db';

export type AssetLifecycleStatus =
  | 'in_service'
  | 'in_repair'
  | 'awaiting_parts'
  | 'reserve'
  | 'decommissioned';

export type AssetEventType =
  | 'created'
  | 'status_change'
  | 'owner_change'
  | 'location_change'
  | 'note';

export interface AssetListItem {
  id: string;
  model: string;
  manufacturer: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  lifecycleStatus: AssetLifecycleStatus;
  riskClass: '1' | '2a' | '2b' | '3' | null;
  ownerClientId: string;
  ownerDisplayName: string;
  createdAt: Date;
}

export interface AssetDetailDto extends AssetListItem {
  location: string | null;
  commissionedAt: string | null;
  warrantyUntil: string | null;
  /** Stage 10'.I — категория аттестации, необходимая для обслуживания. NULL = не требуется. */
  requiredAttestationCategory: string | null;
  notes: string | null;
}

export interface AssetEventDto {
  id: string;
  type: AssetEventType;
  userId: string | null;
  payload: AssetEventPayload;
  createdAt: Date;
}

export interface CreateAssetInput {
  ownerClientId: string;
  model: string;
  manufacturer?: string | null;
  serialNumber?: string | null;
  inventoryNumber?: string | null;
  location?: string | null;
  lifecycleStatus?: AssetLifecycleStatus;
  riskClass?: '1' | '2a' | '2b' | '3' | null;
  requiredAttestationCategory?: string | null;
  commissionedAt?: string | null;
  warrantyUntil?: string | null;
  notes?: string | null;
}

export interface UpdateAssetInput {
  ownerClientId?: string;
  model?: string;
  manufacturer?: string | null;
  serialNumber?: string | null;
  inventoryNumber?: string | null;
  location?: string | null;
  lifecycleStatus?: AssetLifecycleStatus;
  riskClass?: '1' | '2a' | '2b' | '3' | null;
  requiredAttestationCategory?: string | null;
  commissionedAt?: string | null;
  warrantyUntil?: string | null;
  notes?: string | null;
}

const PAGE_SIZE_DEFAULT = 25;

export async function listAssets(
  db: Db,
  tenantId: string,
  opts: {
    search?: string;
    status?: AssetLifecycleStatus;
    ownerClientId?: string;
    page?: number;
  } = {},
): Promise<{ items: AssetListItem[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE_DEFAULT;

  const filters: SQL[] = [];
  if (opts.status) filters.push(eq(assets.lifecycleStatus, opts.status));
  if (opts.ownerClientId) filters.push(eq(assets.ownerClientId, opts.ownerClientId));
  if (opts.search) {
    const q = `%${opts.search.trim()}%`;
    filters.push(
      or(
        ilike(assets.model, q),
        ilike(assets.serialNumber, q),
        ilike(assets.inventoryNumber, q),
      ) as SQL,
    );
  }
  const whereClause = filters.length ? and(...filters) : undefined;

  return withTenantTx(db, tenantId, async (tx) => {
    const items = await tx
      .select({
        id: assets.id,
        model: assets.model,
        manufacturer: assets.manufacturer,
        serialNumber: assets.serialNumber,
        inventoryNumber: assets.inventoryNumber,
        lifecycleStatus: assets.lifecycleStatus,
        riskClass: assets.riskClass,
        ownerClientId: assets.ownerClientId,
        ownerDisplayName: clients.displayName,
        createdAt: assets.createdAt,
      })
      .from(assets)
      .innerJoin(clients, eq(assets.ownerClientId, clients.id))
      .where(whereClause)
      .orderBy(desc(assets.createdAt))
      .limit(PAGE_SIZE_DEFAULT)
      .offset(offset);

    const totalRow = await tx
      .select({ value: count() })
      .from(assets)
      .where(whereClause);

    return {
      items,
      total: Number(totalRow[0]?.value ?? 0),
    };
  });
}

export async function getAsset(
  db: Db,
  tenantId: string,
  id: string,
): Promise<AssetDetailDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: assets.id,
        model: assets.model,
        manufacturer: assets.manufacturer,
        serialNumber: assets.serialNumber,
        inventoryNumber: assets.inventoryNumber,
        lifecycleStatus: assets.lifecycleStatus,
        riskClass: assets.riskClass,
        ownerClientId: assets.ownerClientId,
        ownerDisplayName: clients.displayName,
        location: assets.location,
        commissionedAt: assets.commissionedAt,
        warrantyUntil: assets.warrantyUntil,
        requiredAttestationCategory: assets.requiredAttestationCategory,
        notes: assets.notes,
        createdAt: assets.createdAt,
      })
      .from(assets)
      .innerJoin(clients, eq(assets.ownerClientId, clients.id))
      .where(eq(assets.id, id))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function listAssetsByClient(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<AssetListItem[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    return tx
      .select({
        id: assets.id,
        model: assets.model,
        manufacturer: assets.manufacturer,
        serialNumber: assets.serialNumber,
        inventoryNumber: assets.inventoryNumber,
        lifecycleStatus: assets.lifecycleStatus,
        riskClass: assets.riskClass,
        ownerClientId: assets.ownerClientId,
        ownerDisplayName: clients.displayName,
        createdAt: assets.createdAt,
      })
      .from(assets)
      .innerJoin(clients, eq(assets.ownerClientId, clients.id))
      .where(eq(assets.ownerClientId, clientId))
      .orderBy(desc(assets.createdAt));
  });
}

export async function searchAssets(
  db: Db,
  tenantId: string,
  q: string,
): Promise<Array<Pick<AssetListItem, 'id' | 'model' | 'serialNumber' | 'ownerClientId' | 'ownerDisplayName'>>> {
  const query = `%${q.trim()}%`;
  return withTenantTx(db, tenantId, async (tx) => {
    return tx
      .select({
        id: assets.id,
        model: assets.model,
        serialNumber: assets.serialNumber,
        ownerClientId: assets.ownerClientId,
        ownerDisplayName: clients.displayName,
      })
      .from(assets)
      .innerJoin(clients, eq(assets.ownerClientId, clients.id))
      .where(
        or(
          ilike(assets.model, query),
          ilike(assets.serialNumber, query),
          ilike(assets.inventoryNumber, query),
        ),
      )
      .orderBy(asc(assets.model))
      .limit(10);
  });
}

export async function listEvents(
  db: Db,
  tenantId: string,
  assetId: string,
  limit = 100,
): Promise<AssetEventDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    return tx
      .select({
        id: assetEvents.id,
        type: assetEvents.type,
        userId: assetEvents.userId,
        payload: assetEvents.payload,
        createdAt: assetEvents.createdAt,
      })
      .from(assetEvents)
      .where(eq(assetEvents.assetId, assetId))
      .orderBy(desc(assetEvents.createdAt))
      .limit(limit);
  });
}

/**
 * Insert asset + auto-event 'created' в одной транзакции.
 * Возвращает id созданного asset.
 */
export async function createAssetWithEvent(
  db: Db,
  tenantId: string,
  userId: string | null,
  input: CreateAssetInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(assets)
      .values({
        tenantId,
        ownerClientId: input.ownerClientId,
        model: input.model,
        manufacturer: input.manufacturer ?? null,
        serialNumber: input.serialNumber ?? null,
        inventoryNumber: input.inventoryNumber ?? null,
        location: input.location ?? null,
        lifecycleStatus: input.lifecycleStatus ?? 'in_service',
        riskClass: input.riskClass ?? null,
        requiredAttestationCategory: input.requiredAttestationCategory ?? null,
        commissionedAt: input.commissionedAt ?? null,
        warrantyUntil: input.warrantyUntil ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: assets.id });
    const newId = inserted[0]?.id;
    if (!newId) throw new Error('createAssetWithEvent: insert returned nothing');
    await tx.insert(assetEvents).values({
      tenantId,
      assetId: newId,
      userId,
      type: 'created',
      payload: {},
    });
    return { id: newId };
  });
}

/** Только проверка что client существует в tenant'е (используется service.ts при смене владельца). */
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

/**
 * Update asset с автоматической записью событий при изменении lifecycleStatus / ownerClientId / location.
 * Возвращает массив записанных событий.
 */
export async function updateAssetWithEvents(
  db: Db,
  tenantId: string,
  userId: string | null,
  id: string,
  patch: UpdateAssetInput,
): Promise<{ events: Array<{ type: AssetEventType; payload: AssetEventPayload }> }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const current = await tx
      .select()
      .from(assets)
      .where(eq(assets.id, id))
      .limit(1);
    const before = current[0];
    if (!before) {
      // RLS отсёк или несуществующий id — отдаем пустой результат, service бросит NOT_FOUND
      return { events: [] };
    }

    const setObj: Record<string, unknown> = {};
    if (patch.model !== undefined) setObj.model = patch.model;
    if (patch.manufacturer !== undefined) setObj.manufacturer = patch.manufacturer;
    if (patch.serialNumber !== undefined) setObj.serialNumber = patch.serialNumber;
    if (patch.inventoryNumber !== undefined) setObj.inventoryNumber = patch.inventoryNumber;
    if (patch.location !== undefined) setObj.location = patch.location;
    if (patch.lifecycleStatus !== undefined) setObj.lifecycleStatus = patch.lifecycleStatus;
    if (patch.riskClass !== undefined) setObj.riskClass = patch.riskClass;
    if (patch.requiredAttestationCategory !== undefined)
      setObj.requiredAttestationCategory = patch.requiredAttestationCategory;
    if (patch.commissionedAt !== undefined) setObj.commissionedAt = patch.commissionedAt;
    if (patch.warrantyUntil !== undefined) setObj.warrantyUntil = patch.warrantyUntil;
    if (patch.notes !== undefined) setObj.notes = patch.notes;
    if (patch.ownerClientId !== undefined) setObj.ownerClientId = patch.ownerClientId;

    if (Object.keys(setObj).length === 0) return { events: [] };

    await tx.update(assets).set(setObj).where(eq(assets.id, id));

    const events: Array<{ type: AssetEventType; payload: AssetEventPayload }> = [];
    if (
      patch.lifecycleStatus !== undefined &&
      patch.lifecycleStatus !== before.lifecycleStatus
    ) {
      events.push({
        type: 'status_change',
        payload: { from: before.lifecycleStatus, to: patch.lifecycleStatus },
      });
    }
    if (patch.ownerClientId !== undefined && patch.ownerClientId !== before.ownerClientId) {
      events.push({
        type: 'owner_change',
        payload: { from: before.ownerClientId, to: patch.ownerClientId },
      });
    }
    if (patch.location !== undefined && patch.location !== before.location) {
      events.push({
        type: 'location_change',
        payload: { from: before.location, to: patch.location },
      });
    }

    if (events.length > 0) {
      await tx.insert(assetEvents).values(
        events.map((e) => ({
          tenantId,
          assetId: id,
          userId,
          type: e.type,
          payload: e.payload,
        })),
      );
    }

    return { events };
  });
}

export async function addNote(
  db: Db,
  tenantId: string,
  userId: string | null,
  assetId: string,
  comment: string,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    // Проверяем что asset существует в tenant'е
    const exists = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    if (!exists[0]) throw new Error('Asset not found');
    const inserted = await tx
      .insert(assetEvents)
      .values({
        tenantId,
        assetId,
        userId,
        type: 'note',
        payload: { comment },
      })
      .returning({ id: assetEvents.id });
    return { id: inserted[0]!.id };
  });
}

/** Distinct manufacturers для autosuggest в форме. */
export async function listManufacturers(
  db: Db,
  tenantId: string,
): Promise<string[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx.execute<{ manufacturer: string }>(sql`
      SELECT DISTINCT manufacturer FROM assets
       WHERE manufacturer IS NOT NULL
       ORDER BY manufacturer ASC
       LIMIT 100
    `);
    return (rows as unknown as Array<{ manufacturer: string }>).map((r) => r.manufacturer);
  });
}
