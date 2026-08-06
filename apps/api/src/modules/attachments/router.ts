/**
 * tRPC роутер attachments.
 * RBAC:
 *   - createUploadUrl / confirmUpload / delete: staffProcedure (диспетчер + директор)
 *     + engineerProcedure для photo (инженер должен фото повреждений лить).
 *   - listByReference: engineerProcedure.
 */
import { z } from 'zod';
import { engineerProcedure, router } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import { confirmUploadCmd, createUploadUrlCmd, deleteCmd, listByReferenceQuery } from './service';

const kindEnum = z.enum([
  'ticket_photo',
  'asset_photo',
  'inventory_receipt',
  'damage_photo',
  'completion_photo',
  'contract_signed',
  'document',
]);

const refTypeEnum = z.enum(['ticket', 'asset', 'inventory_batch', 'work_order_line', 'contract']);

export const attachmentsRouter = router({
  createUploadUrl: engineerProcedure
    .input(
      z.object({
        kind: kindEnum,
        referenceType: refTypeEnum,
        referenceId: z.string().uuid(),
        fileName: z.string().trim().min(1).max(300),
        mimeType: z.string().trim().min(1).max(100),
        sizeBytes: z.number().int().positive(),
      }),
    )
    .mutation(({ ctx, input }) => createUploadUrlCmd(buildCmdCtx(ctx), input)),

  confirmUpload: engineerProcedure
    .input(z.object({ attachmentId: z.string().uuid() }))
    .mutation(({ ctx, input }) => confirmUploadCmd(buildCmdCtx(ctx), input.attachmentId)),

  listByReference: engineerProcedure
    .input(z.object({ referenceType: refTypeEnum, referenceId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      listByReferenceQuery(ctx.db, ctx.tenant, input.referenceType, input.referenceId),
    ),

  delete: engineerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteCmd(buildCmdCtx(ctx), input.id)),
});
