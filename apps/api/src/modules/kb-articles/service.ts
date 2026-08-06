/**
 * Service слой для kb_articles.
 *
 * Бизнес-логика:
 *   - searchSimilar: главный сценарий блока «Похожие случаи». Принимает
 *     ticketId | assetId | свободный query и возвращает релевантные статьи.
 *     Алгоритм:
 *       1. Если задан ticketId — берём ticket.symptom + asset.model (если есть)
 *          → склеиваем в search-query, плюс фильтр по asset.model (точное
 *          совпадение даёт буст релевантности через две выборки + dedup).
 *       2. Если задан assetId — то же самое только по asset.
 *       3. Если задан только query — обычный trigram.
 *     Возвращаем максимум `limit` (default 5) активных статей.
 *   - audit пишем для create/update/archive/unarchive (action create/update/delete/restore).
 */
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { assets, tickets, withTenantTx } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import { toTRPCError } from '../../lib/errors';
import {
  archiveArticle as repoArchive,
  createArticle as repoCreate,
  getArticle as repoGet,
  listArticles as repoList,
  unarchiveArticle as repoUnarchive,
  updateArticle as repoUpdate,
  type CreateArticleInput,
  type KbArticleDto,
  type KbArticleListItem,
  type ListOpts,
  type UpdateArticleInput,
} from './repository';
import type { CmdCtx } from '../../trpc/helpers';

const SIMILAR_DEFAULT_LIMIT = 5;
const SIMILAR_MAX_LIMIT = 20;

export async function listArticlesQuery(
  ctx: CmdCtx,
  opts: ListOpts = {},
): Promise<KbArticleListItem[]> {
  return repoList(ctx.db, ctx.tenant.id, opts);
}

export async function getArticleQuery(ctx: CmdCtx, id: string): Promise<KbArticleDto> {
  const article = await repoGet(ctx.db, ctx.tenant.id, id);
  if (!article) throw new TRPCError({ code: 'NOT_FOUND', message: 'Статья не найдена' });
  return article;
}

export async function createArticleCmd(
  ctx: CmdCtx,
  input: Omit<CreateArticleInput, 'createdByUserId'>,
): Promise<KbArticleDto> {
  let article: KbArticleDto;
  try {
    article = await repoCreate(ctx.db, ctx.tenant.id, {
      ...input,
      createdByUserId: ctx.session.userId,
    });
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'kb_article',
    entityId: article.id,
    after: {
      title: article.title,
      tags: article.tags,
      assetModels: article.assetModels,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return article;
}

export async function updateArticleCmd(
  ctx: CmdCtx,
  id: string,
  patch: UpdateArticleInput,
): Promise<KbArticleDto> {
  let article: KbArticleDto;
  try {
    article = await repoUpdate(ctx.db, ctx.tenant.id, id, patch);
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'kb_article',
    entityId: id,
    after: { patchKeys: Object.keys(patch) },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return article;
}

export async function archiveArticleCmd(ctx: CmdCtx, id: string): Promise<KbArticleDto> {
  let article: KbArticleDto;
  try {
    article = await repoArchive(ctx.db, ctx.tenant.id, id);
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete', // Семантически — soft delete.
    entityType: 'kb_article',
    entityId: id,
    after: { archivedAt: article.archivedAt },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return article;
}

export async function unarchiveArticleCmd(ctx: CmdCtx, id: string): Promise<KbArticleDto> {
  let article: KbArticleDto;
  try {
    article = await repoUnarchive(ctx.db, ctx.tenant.id, id);
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'restore',
    entityType: 'kb_article',
    entityId: id,
    after: { archivedAt: null },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return article;
}

export interface SearchSimilarInput {
  /** Свободный текст. Если пустой — берётся из ticket/asset. */
  query?: string;
  /** Если задан — модель и симптом этого тикета добавляются к запросу. */
  ticketId?: string;
  /** Если задан — модель этого асcета добавляется к запросу + точный фильтр. */
  assetId?: string;
  limit?: number;
}

export interface KbSimilarMatch extends KbArticleListItem {
  /** Источник матча: 'model' (точное совпадение модели/asset), 'tag', 'fulltext'. */
  matchReason: 'model' | 'attached' | 'fulltext';
}

/**
 * Поиск похожих статей.
 *
 * Стратегия (две выборки + dedup):
 *   A. По точному совпадению модели/прикреплённому asset (даёт «жёсткие» матчи).
 *   B. По similarity заголовка/тела (даёт нечёткие матчи).
 * Берём A первее B (приоритет точных), дедупим по id.
 *
 * Если `query` слишком короткий, оставляем только A (и возможно ничего).
 */
export async function searchSimilarQuery(
  ctx: CmdCtx,
  input: SearchSimilarInput,
): Promise<KbSimilarMatch[]> {
  const limit = Math.min(Math.max(input.limit ?? SIMILAR_DEFAULT_LIMIT, 1), SIMILAR_MAX_LIMIT);
  const tenantId = ctx.tenant.id;

  const queryParts: string[] = [];
  if (input.query) queryParts.push(input.query.trim());

  let assetModel: string | null = null;
  let attachedAssetId: string | null = null;

  if (input.assetId) {
    const [a] = await withTenantTx(ctx.db, tenantId, (tx) =>
      tx.select({ model: assets.model }).from(assets).where(eq(assets.id, input.assetId!)).limit(1),
    );
    if (a?.model) {
      assetModel = a.model;
      queryParts.push(a.model);
      attachedAssetId = input.assetId;
    }
  }

  if (input.ticketId) {
    const [t] = await withTenantTx(ctx.db, tenantId, (tx) =>
      tx
        .select({
          symptom: tickets.symptom,
          assetId: tickets.assetId,
        })
        .from(tickets)
        .where(eq(tickets.id, input.ticketId!))
        .limit(1),
    );
    if (t?.symptom) queryParts.push(t.symptom);
    if (t?.assetId && !assetModel) {
      const [a] = await withTenantTx(ctx.db, tenantId, (tx) =>
        tx.select({ model: assets.model }).from(assets).where(eq(assets.id, t.assetId!)).limit(1),
      );
      if (a?.model) {
        assetModel = a.model;
        queryParts.push(a.model);
        attachedAssetId = t.assetId;
      }
    }
  }

  const fullQuery = queryParts.filter(Boolean).join(' ').trim();

  const out: KbSimilarMatch[] = [];
  const seen = new Set<string>();

  // A.1 — статьи привязанные к конкретному asset (самое точное совпадение).
  if (attachedAssetId) {
    const attached = await repoList(ctx.db, tenantId, {
      attachedAssetId,
      includeArchived: false,
      limit,
    });
    for (const a of attached) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ ...a, matchReason: 'attached' });
      if (out.length >= limit) return out;
    }
  }

  // A.2 — статьи где asset_models содержит эту модель.
  if (assetModel) {
    const byModel = await repoList(ctx.db, tenantId, {
      assetModel,
      includeArchived: false,
      limit,
    });
    for (const a of byModel) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ ...a, matchReason: 'model' });
      if (out.length >= limit) return out;
    }
  }

  // B — нечёткий поиск по тексту.
  if (fullQuery.length > 0) {
    const byText = await repoList(ctx.db, tenantId, {
      query: fullQuery,
      includeArchived: false,
      limit,
    });
    for (const a of byText) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ ...a, matchReason: 'fulltext' });
      if (out.length >= limit) break;
    }
  }

  return out;
}

export type {
  KbArticleDto,
  KbArticleListItem,
  CreateArticleInput,
  UpdateArticleInput,
  ListOpts,
} from './repository';
