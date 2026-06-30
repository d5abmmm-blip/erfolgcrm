/**
 * tRPC роутер для assets и asset_events.
 *
 * RBAC:
 * - list / byClient — staffProcedure (директор + диспетчер)
 * - get / search / events / addNote — authedProcedure (включая инженера)
 * - create / update — staffProcedure
 * - decommission — directorProcedure (необратимое действие)
 */
import { z } from 'zod';
import { AssetLifecycleStatus, MedDeviceRiskClass } from '@erfolg/shared';
import {
  router,
  authedProcedure,
  directorProcedure,
  staffProcedure,
} from '../../trpc/trpc';
import {
  addAssetNoteCmd,
  assetEventsQuery,
  assetsByClientQuery,
  createAssetCmd,
  decommissionAssetCmd,
  deviceTypesQuery,
  getAssetQuery,
  listAssetsQuery,
  manufacturersQuery,
  searchAssetsQuery,
  updateAssetCmd,
} from './service';

const dateOrNull = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD')
  .nullable();

const createAssetSchema = z.object({
  // null — техника без привязки к клиенту (галочка в форме).
  ownerClientId: z.string().uuid().nullable(),
  assetModelId: z.string().uuid().nullable().optional(),
  model: z.string().trim().min(1).max(200),
  manufacturer: z.string().trim().max(200).nullable().optional(),
  deviceType: z.string().trim().max(100).nullable().optional(),
  serialNumber: z.string().trim().max(100).nullable().optional(),
  inventoryNumber: z.string().trim().max(50).nullable().optional(),
  location: z.string().trim().max(500).nullable().optional(),
  lifecycleStatus: AssetLifecycleStatus.optional(),
  riskClass: MedDeviceRiskClass.nullable().optional(),
  requiredAttestationCategory: z.string().trim().max(100).nullable().optional(),
  commissionedAt: dateOrNull.optional(),
  warrantyUntil: dateOrNull.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const updateAssetSchema = z
  .object({
    // null — снять привязку к клиенту; отсутствует — не менять.
    ownerClientId: z.string().uuid().nullable().optional(),
    assetModelId: z.string().uuid().nullable().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    manufacturer: z.string().trim().max(200).nullable().optional(),
    deviceType: z.string().trim().max(100).nullable().optional(),
    serialNumber: z.string().trim().max(100).nullable().optional(),
    inventoryNumber: z.string().trim().max(50).nullable().optional(),
    location: z.string().trim().max(500).nullable().optional(),
    lifecycleStatus: AssetLifecycleStatus.optional(),
    riskClass: MedDeviceRiskClass.nullable().optional(),
    requiredAttestationCategory: z.string().trim().max(100).nullable().optional(),
    commissionedAt: dateOrNull.optional(),
    warrantyUntil: dateOrNull.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const assetsRouter = router({
  list: staffProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(100).optional(),
          status: AssetLifecycleStatus.optional(),
          ownerClientId: z.string().uuid().optional(),
          page: z.number().int().positive().max(1000).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listAssetsQuery(ctx.db, ctx.tenant, input ?? {})),

  get: authedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getAssetQuery(ctx.db, ctx.tenant, input.id)),

  search: authedProcedure
    .input(z.object({ q: z.string().trim().min(1).max(100) }))
    .query(({ ctx, input }) => searchAssetsQuery(ctx.db, ctx.tenant, input.q)),

  byClient: staffProcedure
    .input(z.object({ clientId: z.string().uuid() }))
    .query(({ ctx, input }) => assetsByClientQuery(ctx.db, ctx.tenant, input.clientId)),

  events: authedProcedure
    .input(z.object({ assetId: z.string().uuid(), limit: z.number().int().positive().max(500).optional() }))
    .query(({ ctx, input }) => assetEventsQuery(ctx.db, ctx.tenant, input.assetId, input.limit)),

  manufacturers: authedProcedure.query(({ ctx }) => manufacturersQuery(ctx.db, ctx.tenant)),

  deviceTypes: authedProcedure.query(({ ctx }) => deviceTypesQuery(ctx.db, ctx.tenant)),

  create: staffProcedure.input(createAssetSchema).mutation(({ ctx, input }) =>
    createAssetCmd(
      ctx.db,
      ctx.tenant,
      ctx.session,
      { ip: ctx.ip, userAgent: ctx.userAgent },
      input,
    ),
  ),

  update: staffProcedure
    .input(z.object({ id: z.string().uuid(), patch: updateAssetSchema }))
    .mutation(({ ctx, input }) =>
      updateAssetCmd(
        ctx.db,
        ctx.tenant,
        ctx.session,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.id,
        input.patch,
      ),
    ),

  addNote: staffProcedure
    .input(z.object({ assetId: z.string().uuid(), comment: z.string().trim().min(1).max(2000) }))
    .mutation(({ ctx, input }) =>
      addAssetNoteCmd(
        ctx.db,
        ctx.tenant,
        ctx.session,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.assetId,
        input.comment,
      ),
    ),

  decommission: directorProcedure
    .input(z.object({ id: z.string().uuid(), comment: z.string().trim().max(2000).optional() }))
    .mutation(({ ctx, input }) =>
      decommissionAssetCmd(
        ctx.db,
        ctx.tenant,
        ctx.session,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.id,
        input.comment,
      ),
    ),
});
