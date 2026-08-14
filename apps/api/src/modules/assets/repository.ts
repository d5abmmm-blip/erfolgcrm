/**
 * Repository для assets/asset_events. Чистые DB-функции.
 *
 * Бизнес-инвариант «при изменении lifecycleStatus/ownerClientId/location
 * автоматически появляется asset_event» реализован в service.ts (одна транзакция).
 */
import { and, asc, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { ruIlike } from '../../lib/ru-search';
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
  /** Тип/категория аппарата (УЗИ, рентген…). NULL — не задан. */
  deviceType: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  lifecycleStatus: AssetLifecycleStatus;
  riskClass: '1' | '2a' | '2b' | '3' | null;
  /** NULL — техника без привязки к клиенту (см. миграцию 0059). */
  ownerClientId: string | null;
  /** NULL — у техники нет клиента-владельца. */
  ownerDisplayName: string | null;
  createdAt: Date;
}

export interface AssetDetailDto extends AssetListItem {
  location: string | null;
  commissionedAt: string | null;
  warrantyUntil: string | null;
  /** Stage 10'.I — категория аттестации, необходимая для обслуживания. NULL = не требуется. */
  requiredAttestationCategory: string | null;
  /** Ссылка на модель из каталога (asset_models). NULL — заведено свободным текстом. */
  assetModelId: string | null;
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
  /** NULL — завести технику без привязки к клиенту. */
  ownerClientId: string | null;
  assetModelId?: string | null;
  model: string;
  manufacturer?: string | null;
  deviceType?: string | null;
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
  /** NULL — снять привязку к клиенту; undefined — не менять. */
  ownerClientId?: string | null;
  assetModelId?: string | null;
  model?: string;
  manufacturer?: string | null;
  deviceType?: string | null;
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
        ruIlike(assets.model, q),
        ruIlike(assets.serialNumber, q),
        ruIlike(assets.inventoryNumber, q),
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
        deviceType: assets.deviceType,
        serialNumber: assets.serialNumber,
        inventoryNumber: assets.inventoryNumber,
        lifecycleStatus: assets.lifecycleStatus,
        riskClass: assets.riskClass,
        ownerClientId: assets.ownerClientId,
        ownerDisplayName: clients.displayName,
        createdAt: assets.createdAt,
      })
      .from(assets)
      // leftJoin (не inner): техника без клиента-владельца тоже попадает в список.
      .leftJoin(clients, eq(assets.ownerClientId, clients.id))
      .where(whereClause)
      .orderBy(desc(assets.createdAt))
      .limit(PAGE_SIZE_DEFAULT)
      .offset(offset);

    const totalRow = await tx.select({ value: count() }).from(assets).where(whereClause);

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
        deviceType: assets.deviceType,
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
        assetModelId: assets.assetModelId,
        notes: assets.notes,
        createdAt: assets.createdAt,
      })
      .from(assets)
      // leftJoin (не inner): карточка техники без клиента-владельца тоже открывается.
      .leftJoin(clients, eq(assets.ownerClientId, clients.id))
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
        deviceType: assets.deviceType,
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
): Promise<
  Array<
    Pick<
      AssetListItem,
      'id' | 'model' | 'serialNumber' | 'inventoryNumber' | 'ownerClientId' | 'ownerDisplayName'
    >
  >
> {
  const query = `%${q.trim()}%`;
  return withTenantTx(db, tenantId, async (tx) => {
    return (
      tx
        .select({
          id: assets.id,
          model: assets.model,
          serialNumber: assets.serialNumber,
          // Ищем по инвентарному номеру давно, а в выдаче его не было: находка
          // выглядела как «совпало непонятно с чем».
          inventoryNumber: assets.inventoryNumber,
          ownerClientId: assets.ownerClientId,
          ownerDisplayName: clients.displayName,
        })
        .from(assets)
        // leftJoin (не inner): техника без клиента тоже находится поиском.
        .leftJoin(clients, eq(assets.ownerClientId, clients.id))
        .where(
          or(
            ruIlike(assets.model, query),
            ruIlike(assets.serialNumber, query),
            ruIlike(assets.inventoryNumber, query),
          ),
        )
        .orderBy(asc(assets.model))
        .limit(10)
    );
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
        ownerClientId: input.ownerClientId ?? null,
        assetModelId: input.assetModelId ?? null,
        model: input.model,
        manufacturer: input.manufacturer ?? null,
        deviceType: input.deviceType ?? null,
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
    const current = await tx.select().from(assets).where(eq(assets.id, id)).limit(1);
    const before = current[0];
    if (!before) {
      // RLS отсёк или несуществующий id — отдаем пустой результат, service бросит NOT_FOUND
      return { events: [] };
    }

    const setObj: Record<string, unknown> = {};
    if (patch.assetModelId !== undefined) setObj.assetModelId = patch.assetModelId;
    if (patch.model !== undefined) setObj.model = patch.model;
    if (patch.manufacturer !== undefined) setObj.manufacturer = patch.manufacturer;
    if (patch.deviceType !== undefined) setObj.deviceType = patch.deviceType;
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
    if (patch.lifecycleStatus !== undefined && patch.lifecycleStatus !== before.lifecycleStatus) {
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
export async function listManufacturers(db: Db, tenantId: string): Promise<string[]> {
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

/**
 * Словарь типов оборудования — и для формы техники, и для отметки «что обслуживает
 * инженер». Один список на оба конца сравнения: если навык записан словом из другого
 * словаря («Кардиограф»), он не совпадёт с техникой («ЭКГ») никогда.
 *
 * Источники — только реальные данные: заведённая техника, каталог моделей и архив
 * ремонтов прежней системы. Архив здесь главный: на бою `assets.device_type` пуст у
 * всех 5044 единиц, а в архиве тип проставлен у 4266 строк из 4267.
 *
 * Порядок — по частоте: сверху то, что чинят чаще всего, с него и начинают отмечать.
 * Одинаковые типы в разном регистре схлопываем (кириллице нужен COLLATE "ru-x-icu" —
 * в C-локали lower() её не сворачивает), показываем самое частое написание.
 */
export async function listDeviceTypes(db: Db, tenantId: string): Promise<string[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx.execute<{ device_type: string }>(sql`
      WITH src AS (
        SELECT btrim(device_type) AS device_type FROM assets
         WHERE device_type IS NOT NULL AND btrim(device_type) <> ''
        UNION ALL
        SELECT btrim(device_type) FROM asset_models
         WHERE device_type IS NOT NULL AND btrim(device_type) <> ''
        UNION ALL
        SELECT btrim(device_type) FROM repair_archive
         WHERE device_type IS NOT NULL AND btrim(device_type) <> ''
      ),
      spellings AS (
        SELECT lower(device_type COLLATE "ru-x-icu") AS key,
               device_type,
               count(*)::int AS spelling_cnt
          FROM src GROUP BY 1, 2
      ),
      totals AS (
        SELECT key, sum(spelling_cnt)::int AS cnt FROM spellings GROUP BY 1
      )
      SELECT x.device_type FROM (
        SELECT DISTINCT ON (s.key) s.device_type AS device_type, t.cnt AS cnt
          FROM spellings s JOIN totals t ON t.key = s.key
         ORDER BY s.key, s.spelling_cnt DESC, s.device_type ASC
      ) x
       ORDER BY x.cnt DESC, x.device_type ASC
       LIMIT 200
    `);
    return (rows as unknown as Array<{ device_type: string }>).map((r) => r.device_type);
  });
}

/**
 * Тип техники по названию модели — из архива ремонтов прежней системы.
 *
 * Нужен там, где в карточке техники тип не заполнен (на бою — везде). Отдаём ТОЛЬКО
 * когда все архивные записи по этой модели сходятся в одном типе: если в архиве по
 * одной модели встречаются разные типы, угадывать нельзя — молчим.
 */
export async function deviceTypeByModel(
  db: Db,
  tenantId: string,
  model: string,
): Promise<string | null> {
  const needle = model.trim();
  if (!needle) return null;
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx.execute<{ device_type: string }>(sql`
      SELECT min(btrim(device_type)) AS device_type
        FROM repair_archive
       WHERE device_model IS NOT NULL
         AND device_type IS NOT NULL
         AND btrim(device_type) <> ''
         AND lower(btrim(device_model) COLLATE "ru-x-icu") = lower(${needle} COLLATE "ru-x-icu")
      HAVING count(DISTINCT lower(btrim(device_type) COLLATE "ru-x-icu")) = 1
    `);
    return (rows as unknown as Array<{ device_type: string }>)[0]?.device_type ?? null;
  });
}
