/**
 * Repository для каталога моделей техники (asset_models). Чистые DB-функции.
 *
 * Каталог — справочник типов аппаратов (производитель + модель), не привязанный
 * к клиенту. Дубли по (manufacturer, model) предотвращаются здесь же —
 * createAssetModel реализует case-insensitive find-or-create (на уровне БД
 * жёсткой уникальности нет из-за локали «C» и кириллицы, см. lib/ru-search.ts).
 */
import { and, asc, count, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { ruIlike } from '../../lib/ru-search';
import { assetModels, withTenantTx, type Db } from '@erfolg/db';

export type RiskClass = '1' | '2a' | '2b' | '3';

export interface AssetModelDto {
  id: string;
  manufacturer: string | null;
  model: string;
  riskClass: RiskClass | null;
  requiredAttestationCategory: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface AssetModelSearchItem {
  id: string;
  manufacturer: string | null;
  model: string;
  riskClass: RiskClass | null;
  requiredAttestationCategory: string | null;
}

export interface CreateAssetModelInput {
  manufacturer?: string | null;
  model: string;
  riskClass?: RiskClass | null;
  requiredAttestationCategory?: string | null;
  notes?: string | null;
}

export interface UpdateAssetModelInput {
  manufacturer?: string | null;
  model?: string;
  riskClass?: RiskClass | null;
  requiredAttestationCategory?: string | null;
  notes?: string | null;
}

const PAGE_SIZE_DEFAULT = 25;

/** Регистронезависимое РАВЕНСТВО для кириллицы (без wildcard'ов LIKE). */
function ruEq(column: Parameters<typeof ruIlike>[0], value: string): SQL {
  return sql`lower(${column} COLLATE "ru-x-icu") = ${value.toLowerCase()}`;
}

/** Сравнение производителя с учётом NULL/пустой строки (оба считаются «не задан»). */
function manufacturerEq(value: string | null | undefined): SQL {
  const v = (value ?? '').trim().toLowerCase();
  return sql`lower(coalesce(${assetModels.manufacturer}, '') COLLATE "ru-x-icu") = ${v}`;
}

export async function listAssetModels(
  db: Db,
  tenantId: string,
  opts: { search?: string; page?: number } = {},
): Promise<{ items: AssetModelDto[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE_DEFAULT;

  const filters: SQL[] = [isNull(assetModels.deletedAt)];
  if (opts.search) {
    const q = `%${opts.search.trim()}%`;
    filters.push(
      or(ruIlike(assetModels.model, q), ruIlike(assetModels.manufacturer, q)) as SQL,
    );
  }
  const whereClause = and(...filters);

  return withTenantTx(db, tenantId, async (tx) => {
    const items = await tx
      .select({
        id: assetModels.id,
        manufacturer: assetModels.manufacturer,
        model: assetModels.model,
        riskClass: assetModels.riskClass,
        requiredAttestationCategory: assetModels.requiredAttestationCategory,
        notes: assetModels.notes,
        createdAt: assetModels.createdAt,
      })
      .from(assetModels)
      .where(whereClause)
      .orderBy(asc(assetModels.model))
      .limit(PAGE_SIZE_DEFAULT)
      .offset(offset);

    const totalRow = await tx
      .select({ value: count() })
      .from(assetModels)
      .where(whereClause);

    return { items, total: Number(totalRow[0]?.value ?? 0) };
  });
}

export async function searchAssetModels(
  db: Db,
  tenantId: string,
  q: string,
): Promise<AssetModelSearchItem[]> {
  const query = `%${q.trim()}%`;
  return withTenantTx(db, tenantId, async (tx) => {
    return tx
      .select({
        id: assetModels.id,
        manufacturer: assetModels.manufacturer,
        model: assetModels.model,
        riskClass: assetModels.riskClass,
        requiredAttestationCategory: assetModels.requiredAttestationCategory,
      })
      .from(assetModels)
      .where(
        and(
          isNull(assetModels.deletedAt),
          or(ruIlike(assetModels.model, query), ruIlike(assetModels.manufacturer, query)),
        ),
      )
      .orderBy(asc(assetModels.model))
      .limit(10);
  });
}

export async function getAssetModel(
  db: Db,
  tenantId: string,
  id: string,
): Promise<AssetModelDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: assetModels.id,
        manufacturer: assetModels.manufacturer,
        model: assetModels.model,
        riskClass: assetModels.riskClass,
        requiredAttestationCategory: assetModels.requiredAttestationCategory,
        notes: assetModels.notes,
        createdAt: assetModels.createdAt,
      })
      .from(assetModels)
      .where(and(eq(assetModels.id, id), isNull(assetModels.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Find-or-create по (manufacturer, model) case-insensitive. Возвращает id и флаг
 * created (false — нашли существующую модель, новую не заводили).
 */
export async function createAssetModel(
  db: Db,
  tenantId: string,
  input: CreateAssetModelInput,
): Promise<{ id: string; created: boolean }> {
  const model = input.model.trim();
  return withTenantTx(db, tenantId, async (tx) => {
    const existing = await tx
      .select({ id: assetModels.id })
      .from(assetModels)
      .where(
        and(
          isNull(assetModels.deletedAt),
          ruEq(assetModels.model, model),
          manufacturerEq(input.manufacturer),
        ),
      )
      .limit(1);
    if (existing[0]) return { id: existing[0].id, created: false };

    const inserted = await tx
      .insert(assetModels)
      .values({
        tenantId,
        manufacturer: input.manufacturer?.trim() || null,
        model,
        riskClass: input.riskClass ?? null,
        requiredAttestationCategory: input.requiredAttestationCategory ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: assetModels.id });
    const newId = inserted[0]?.id;
    if (!newId) throw new Error('createAssetModel: insert returned nothing');
    return { id: newId, created: true };
  });
}

export async function updateAssetModel(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateAssetModelInput,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const setObj: Record<string, unknown> = {};
    if (patch.manufacturer !== undefined) setObj.manufacturer = patch.manufacturer?.trim() || null;
    if (patch.model !== undefined) setObj.model = patch.model.trim();
    if (patch.riskClass !== undefined) setObj.riskClass = patch.riskClass;
    if (patch.requiredAttestationCategory !== undefined)
      setObj.requiredAttestationCategory = patch.requiredAttestationCategory;
    if (patch.notes !== undefined) setObj.notes = patch.notes;
    if (Object.keys(setObj).length === 0) return false;

    const res = await tx
      .update(assetModels)
      .set(setObj)
      .where(and(eq(assetModels.id, id), isNull(assetModels.deletedAt)))
      .returning({ id: assetModels.id });
    return res.length > 0;
  });
}
