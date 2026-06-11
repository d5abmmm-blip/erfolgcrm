/**
 * tRPC роутер warranties.
 * RBAC:
 *   - list / get / listByAsset / stats: engineerProcedure (инженеру нужно видеть гарантию на заявке).
 *   - create / update / archive:        staffProcedure (диспетчер + директор).
 */
import { z } from 'zod';
import { WarrantyStatus, WarrantyType } from '@erfolg/shared';
import { engineerProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  archiveWarrantyCmd,
  createWarrantyCmd,
  getWarrantyQuery,
  listByAssetQuery,
  listWarrantiesQuery,
  updateWarrantyCmd,
  warrantyStatsQuery,
} from './service';

/** ISO-8601 date YYYY-MM-DD. */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Дата должна быть в формате YYYY-MM-DD' });

export const warrantiesRouter = router({
  list: engineerProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        status: WarrantyStatus.optional(),
        type: WarrantyType.optional(),
        assetId: z.string().uuid().optional(),
        page: z.number().int().min(1).optional(),
      }),
    )
    .query(({ ctx, input }) => listWarrantiesQuery(ctx.db, ctx.tenant, input)),

  get: engineerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getWarrantyQuery(ctx.db, ctx.tenant, input.id)),

  listByAsset: engineerProcedure
    .input(z.object({ assetId: z.string().uuid() }))
    .query(({ ctx, input }) => listByAssetQuery(ctx.db, ctx.tenant, input.assetId)),

  stats: engineerProcedure.query(({ ctx }) => warrantyStatsQuery(ctx.db, ctx.tenant)),

  create: staffProcedure
    .input(
      z.object({
        assetId: z.string().uuid(),
        type: WarrantyType.optional(),
        startDate: dateString,
        endDate: dateString,
        coverageDescription: z.string().trim().max(5000).nullable().optional(),
        provider: z.string().trim().max(255).nullable().optional(),
        contractNumber: z.string().trim().max(128).nullable().optional(),
        notes: z.string().trim().max(5000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => createWarrantyCmd(buildCmdCtx(ctx), input)),

  update: staffProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            type: WarrantyType.optional(),
            startDate: dateString.optional(),
            endDate: dateString.optional(),
            voided: z.boolean().optional(),
            coverageDescription: z.string().trim().max(5000).nullable().optional(),
            provider: z.string().trim().max(255).nullable().optional(),
            contractNumber: z.string().trim().max(128).nullable().optional(),
            notes: z.string().trim().max(5000).nullable().optional(),
          })
          .strict(),
      }),
    )
    .mutation(({ ctx, input }) => updateWarrantyCmd(buildCmdCtx(ctx), input.id, input.patch)),

  archive: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => archiveWarrantyCmd(buildCmdCtx(ctx), input.id)),
});
