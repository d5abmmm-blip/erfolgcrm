/**
 * Repository для kb_articles.
 *
 * Все запросы — через withTenantTx, чтобы RLS отрабатывал (видим только свой tenant).
 *
 * Поиск:
 *   - searchByQuery: pg_trgm similarity по lower(title || ' ' || body).
 *     Для коротких запросов ставим threshold ниже (1 символ — фильтруем по
 *     ILIKE-фолбэку, иначе trigram ничего не вернёт).
 *   - searchByAssetModels: точное совпадение моделей через && (overlap).
 *   - searchByAttachedAsset: точное совпадение конкретного asset.id (через @>).
 *
 * orderBy: similarity DESC при поиске, иначе updated_at DESC.
 */
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { kbArticles, withTenantTx, type Db } from '@erfolg/db';
import { KbArticleNotFoundError } from '../../lib/errors';

export interface KbArticleListItem {
  id: string;
  title: string;
  bodyExcerpt: string;
  tags: string[];
  assetModels: string[];
  attachedAssetIds: string[];
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Заполнен только при поиске. NULL для обычного list. */
  similarity: number | null;
}

export interface KbArticleDto {
  id: string;
  title: string;
  body: string;
  tags: string[];
  assetModels: string[];
  attachedAssetIds: string[];
  archivedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateArticleInput {
  title: string;
  body: string;
  tags: string[];
  assetModels: string[];
  attachedAssetIds: string[];
  createdByUserId: string | null;
}

export interface UpdateArticleInput {
  title?: string;
  body?: string;
  tags?: string[];
  assetModels?: string[];
  attachedAssetIds?: string[];
}

export interface ListOpts {
  query?: string;
  tag?: string;
  assetModel?: string;
  attachedAssetId?: string;
  includeArchived?: boolean;
  /** Жёсткий лимит, иначе возвращаем все (статей не будут сотни). */
  limit?: number;
}

/** Минимальная длина запроса для trigram-поиска (3 = 1 триграмма). */
const TRGM_MIN_LENGTH = 3;

/**
 * Пороговое значение similarity (pg_trgm default = 0.3, понижаем до 0.1).
 *
 * Важно: pg_trgm на нашей БД (datctype='C') возвращает 0 для Cyrillic-текста,
 * потому что в C-локали кириллица не считается «буквенной». Поэтому trigram —
 * только бонус для ASCII-запросов / опечаток. Главный путь поиска — ILIKE.
 */
const TRGM_THRESHOLD = 0.1;

function bodyExcerpt(body: string): string {
  const cleaned = body.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 200) return cleaned;
  return cleaned.slice(0, 200) + '…';
}

function toListItem(
  row: typeof kbArticles.$inferSelect,
  similarity: number | null = null,
): KbArticleListItem {
  return {
    id: row.id,
    title: row.title,
    bodyExcerpt: bodyExcerpt(row.body),
    tags: row.tags,
    assetModels: row.assetModels,
    attachedAssetIds: row.attachedAssetIds,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    similarity,
  };
}

function toDto(row: typeof kbArticles.$inferSelect): KbArticleDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: row.tags,
    assetModels: row.assetModels,
    attachedAssetIds: row.attachedAssetIds,
    archivedAt: row.archivedAt,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Полный list с фильтрами (используется в /kb и в searchSimilar).
 *
 * Если задан query — добавляем similarity-колонку и сортируем по ней.
 * Если задан assetModel или attachedAssetId — фильтруем точным совпадением.
 * Архивные показываем только при includeArchived.
 */
export async function listArticles(
  db: Db,
  tenantId: string,
  opts: ListOpts,
): Promise<KbArticleListItem[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [];
    if (!opts.includeArchived) {
      filters.push(isNull(kbArticles.archivedAt));
    }
    if (opts.tag) {
      filters.push(sql`${kbArticles.tags} @> ARRAY[${opts.tag}]::text[]`);
    }
    if (opts.assetModel) {
      filters.push(sql`${kbArticles.assetModels} @> ARRAY[${opts.assetModel}]::text[]`);
    }
    if (opts.attachedAssetId) {
      filters.push(sql`${kbArticles.attachedAssetIds} @> ARRAY[${opts.attachedAssetId}]::uuid[]`);
    }

    const queryRaw = (opts.query ?? '').trim().toLowerCase();
    const hasQuery = queryRaw.length > 0;

    // Если есть запрос — комбинируем ICU-аварийную ILIKE-выборку (для Cyrillic
    // substring; в C-локали обычный lower() не case-folding-ит кириллицу, поэтому
    // явный COLLATE "ru-x-icu") и trigram (бонус для ASCII typos).
    // Без запроса — обычный list по updated_at.
    if (hasQuery) {
      const ilikePattern = '%' + queryRaw + '%';
      // lower(...) с явной ICU-collation работает и для кириллицы (C-locale lower
      // оставляет верхний регистр на месте — потому ILIKE не помогал бы).
      const lowerExpr = sql`lower((${kbArticles.title} || ' ' || ${kbArticles.body}) COLLATE "ru-x-icu")`;
      const ilikeExpr = sql`${lowerExpr} LIKE ${ilikePattern}`;
      const useTrigram = queryRaw.length >= TRGM_MIN_LENGTH;
      const simExpr = sql<number>`similarity(${lowerExpr}, ${queryRaw})`;

      const matchExpr = useTrigram
        ? sql`(${ilikeExpr} OR ${simExpr} > ${TRGM_THRESHOLD})`
        : ilikeExpr;

      const whereSql = filters.length > 0 ? and(...filters, matchExpr) : matchExpr;

      // Score: 1.0 бонус за substring-совпадение + similarity (точное вхождение
      // ставится выше нечёткого).
      const scoreExpr = useTrigram
        ? sql<number>`(CASE WHEN ${ilikeExpr} THEN 1.0 ELSE 0 END + ${simExpr})`
        : sql<number>`(CASE WHEN ${ilikeExpr} THEN 1.0 ELSE 0 END)`;

      const rows = await tx
        .select({ row: kbArticles, score: scoreExpr })
        .from(kbArticles)
        .where(whereSql)
        .orderBy(desc(scoreExpr), desc(kbArticles.updatedAt))
        .limit(opts.limit ?? 200);
      return rows.map((r) => toListItem(r.row, r.score));
    }

    const whereSql = filters.length > 0 ? and(...filters) : undefined;
    const rows = await tx
      .select()
      .from(kbArticles)
      .where(whereSql)
      .orderBy(desc(kbArticles.updatedAt), asc(kbArticles.title))
      .limit(opts.limit ?? 200);
    return rows.map((r) => toListItem(r));
  });
}

export async function getArticle(
  db: Db,
  tenantId: string,
  id: string,
): Promise<KbArticleDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx.select().from(kbArticles).where(eq(kbArticles.id, id)).limit(1);
    return rows[0] ? toDto(rows[0]) : null;
  });
}

export async function createArticle(
  db: Db,
  tenantId: string,
  input: CreateArticleInput,
): Promise<KbArticleDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(kbArticles)
      .values({
        tenantId,
        title: input.title,
        body: input.body,
        tags: input.tags,
        assetModels: input.assetModels,
        attachedAssetIds: input.attachedAssetIds,
        createdByUserId: input.createdByUserId,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('createArticle: insert returned nothing');
    return toDto(row);
  });
}

export async function updateArticle(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateArticleInput,
): Promise<KbArticleDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const setObj: Record<string, unknown> = {};
    if (patch.title !== undefined) setObj.title = patch.title;
    if (patch.body !== undefined) setObj.body = patch.body;
    if (patch.tags !== undefined) setObj.tags = patch.tags;
    if (patch.assetModels !== undefined) setObj.assetModels = patch.assetModels;
    if (patch.attachedAssetIds !== undefined) setObj.attachedAssetIds = patch.attachedAssetIds;
    if (Object.keys(setObj).length === 0) {
      const existing = await tx.select().from(kbArticles).where(eq(kbArticles.id, id)).limit(1);
      if (!existing[0]) throw new KbArticleNotFoundError();
      return toDto(existing[0]);
    }
    setObj.updatedAt = new Date();
    const updated = await tx
      .update(kbArticles)
      .set(setObj)
      .where(eq(kbArticles.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new KbArticleNotFoundError();
    return toDto(row);
  });
}

export async function archiveArticle(db: Db, tenantId: string, id: string): Promise<KbArticleDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(kbArticles)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(kbArticles.id, id), isNull(kbArticles.archivedAt)))
      .returning();
    const row = updated[0];
    if (!row) {
      const existing = await tx.select().from(kbArticles).where(eq(kbArticles.id, id)).limit(1);
      if (!existing[0]) throw new KbArticleNotFoundError();
      return toDto(existing[0]);
    }
    return toDto(row);
  });
}

export async function unarchiveArticle(
  db: Db,
  tenantId: string,
  id: string,
): Promise<KbArticleDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(kbArticles)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(kbArticles.id, id))
      .returning();
    const row = updated[0];
    if (!row) throw new KbArticleNotFoundError();
    return toDto(row);
  });
}
