/**
 * tRPC роутер для каталога моделей техники (asset_models).
 *
 * RBAC:
 * - search / get — authedProcedure (нужно инженеру при просмотре)
 * - list / create / update — staffProcedure (директор + диспетчер ведут справочник)
 */
import { z } from 'zod';
import { MedDeviceRiskClass } from '@erfolg/shared';
import { router, authedProcedure, staffProcedure } from '../../trpc/trpc';
import {
  createAssetModelCmd,
  getAssetModelQuery,
  listAssetModelsQuery,
  searchAssetModelsQuery,
  updateAssetModelCmd,
} from './service';

const createSchema = z.object({
  manufacturer: z.string().trim().max(200).nullable().optional(),
  deviceType: z.string().trim().max(100).nullable().optional(),
  model: z.string().trim().min(1).max(200),
  riskClass: MedDeviceRiskClass.nullable().optional(),
  requiredAttestationCategory: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const updateSchema = z
  .object({
    manufacturer: z.string().trim().max(200).nullable().optional(),
    deviceType: z.string().trim().max(100).nullable().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    riskClass: MedDeviceRiskClass.nullable().optional(),
    requiredAttestationCategory: z.string().trim().max(100).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const assetModelsRouter = router({
  list: staffProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(100).optional(),
          page: z.number().int().positive().max(1000).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listAssetModelsQuery(ctx.db, ctx.tenant, input ?? {})),

  search: authedProcedure
    .input(z.object({ q: z.string().trim().min(1).max(100) }))
    .query(({ ctx, input }) => searchAssetModelsQuery(ctx.db, ctx.tenant, input.q)),

  get: authedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getAssetModelQuery(ctx.db, ctx.tenant, input.id)),

  create: staffProcedure.input(createSchema).mutation(({ ctx, input }) =>
    createAssetModelCmd(
      ctx.db,
      ctx.tenant,
      ctx.session,
      { ip: ctx.ip, userAgent: ctx.userAgent },
      input,
    ),
  ),

  update: staffProcedure
    .input(z.object({ id: z.string().uuid(), patch: updateSchema }))
    .mutation(({ ctx, input }) =>
      updateAssetModelCmd(
        ctx.db,
        ctx.tenant,
        ctx.session,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.id,
        input.patch,
      ),
    ),
});
