/**
 * tRPC роутер для базы знаний.
 *
 * RBAC:
 *   - list / get / searchSimilar — engineerProcedure (инженер тоже видит, чтобы
 *     открыть статью прямо из мобильной карточки заявки в будущем).
 *   - create / update / archive / unarchive — staffProcedure
 *     (директор и диспетчер ведут «вики», инженеры пока только читают).
 *
 * Поля:
 *   - title: 1..200, обязательно.
 *   - body: до 100k (markdown), допускается пустая строка для черновика.
 *   - tags / asset_models — нормализуем (trim, lowercase для tags).
 *   - attachedAssetIds — uuid[].
 */
import { z } from 'zod';
import {
  router,
  engineerProcedure,
  staffProcedure,
} from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  archiveArticleCmd,
  createArticleCmd,
  getArticleQuery,
  listArticlesQuery,
  searchSimilarQuery,
  unarchiveArticleCmd,
  updateArticleCmd,
} from './service';

const MAX_BODY_LENGTH = 100_000;

const tagsSchema = z
  .array(z.string().trim().min(1).max(50))
  .max(50)
  .transform((arr) =>
    Array.from(new Set(arr.map((t) => t.toLowerCase()))).sort(),
  );

const assetModelsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(50)
  .transform((arr) => Array.from(new Set(arr.map((t) => t.trim()))));

const attachedAssetsSchema = z
  .array(z.string().uuid())
  .max(50)
  .transform((arr) => Array.from(new Set(arr)));

const createSchema = z.object({
  title: z.string().trim().min(1, 'Заголовок обязателен').max(200),
  body: z.string().max(MAX_BODY_LENGTH).default(''),
  tags: tagsSchema.default([]),
  assetModels: assetModelsSchema.default([]),
  attachedAssetIds: attachedAssetsSchema.default([]),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(MAX_BODY_LENGTH).optional(),
    tags: tagsSchema.optional(),
    assetModels: assetModelsSchema.optional(),
    attachedAssetIds: attachedAssetsSchema.optional(),
  })
  .strict();

const listSchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    tag: z.string().trim().max(50).optional(),
    assetModel: z.string().trim().max(200).optional(),
    attachedAssetId: z.string().uuid().optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .optional();

const searchSimilarSchema = z
  .object({
    query: z.string().trim().max(500).optional(),
    ticketId: z.string().uuid().optional(),
    assetId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .refine(
    (v) =>
      Boolean(
        (v.query && v.query.length > 0) || v.ticketId || v.assetId,
      ),
    { message: 'Нужен хотя бы один из параметров: query, ticketId или assetId' },
  );

export const kbArticlesRouter = router({
  list: engineerProcedure
    .input(listSchema)
    .query(({ ctx, input }) =>
      listArticlesQuery(buildCmdCtx(ctx), input ?? {}),
    ),

  get: engineerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getArticleQuery(buildCmdCtx(ctx), input.id)),

  searchSimilar: engineerProcedure
    .input(searchSimilarSchema)
    .query(({ ctx, input }) => searchSimilarQuery(buildCmdCtx(ctx), input)),

  create: staffProcedure
    .input(createSchema)
    .mutation(({ ctx, input }) =>
      createArticleCmd(buildCmdCtx(ctx), {
        title: input.title,
        body: input.body,
        tags: input.tags,
        assetModels: input.assetModels,
        attachedAssetIds: input.attachedAssetIds,
      }),
    ),

  update: staffProcedure
    .input(z.object({ id: z.string().uuid(), patch: updateSchema }))
    .mutation(({ ctx, input }) =>
      updateArticleCmd(buildCmdCtx(ctx), input.id, input.patch),
    ),

  archive: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => archiveArticleCmd(buildCmdCtx(ctx), input.id)),

  unarchive: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      unarchiveArticleCmd(buildCmdCtx(ctx), input.id),
    ),
});
