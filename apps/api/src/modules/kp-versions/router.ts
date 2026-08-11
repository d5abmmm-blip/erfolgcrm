/**
 * tRPC роутер ticketKp (версии коммерческих предложений по заявке).
 * RBAC: ВСЁ — staffProcedure. Решение владельца 2026-08-11: суммы КП инженеру
 * «не нужны видеть» — раньше listByTicket/latest были engineerProcedure, и
 * суммы предложений любой заявки читались инженером.
 *
 * Суммы принимаются в копейках (целое число ≥ 0) и конвертируются в bigint.
 */
import { z } from 'zod';
import { router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  approveKpCmd,
  archiveKpCmd,
  createKpCmd,
  latestByTicketQuery,
  listByTicketQuery,
  updateKpCmd,
} from './service';

/** Копейки: целое неотрицательное, в пределах безопасного integer. */
const kopecks = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Статусы, доступные через update (approve — отдельной процедурой). */
const editableStatus = z.enum(['draft', 'sent', 'rejected', 'revision']);

export const ticketKpRouter = router({
  listByTicket: staffProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(({ ctx, input }) => listByTicketQuery(ctx.db, ctx.tenant, input.ticketId)),

  latest: staffProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(({ ctx, input }) => latestByTicketQuery(ctx.db, ctx.tenant, input.ticketId)),

  create: staffProcedure
    .input(
      z.object({
        ticketId: z.string().uuid(),
        status: z.enum(['draft', 'sent']).optional(),
        worksAmountKopecks: kopecks,
        partsAmountKopecks: kopecks,
        description: z.string().trim().min(1).max(10_000),
      }),
    )
    .mutation(({ ctx, input }) =>
      createKpCmd(buildCmdCtx(ctx), {
        ticketId: input.ticketId,
        status: input.status,
        worksAmountKopecks: BigInt(input.worksAmountKopecks),
        partsAmountKopecks: BigInt(input.partsAmountKopecks),
        description: input.description,
      }),
    ),

  update: staffProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            status: editableStatus.optional(),
            worksAmountKopecks: kopecks.optional(),
            partsAmountKopecks: kopecks.optional(),
            description: z.string().trim().min(1).max(10_000).optional(),
            rejectionReason: z.string().trim().max(2000).nullable().optional(),
          })
          .strict(),
      }),
    )
    .mutation(({ ctx, input }) =>
      updateKpCmd(buildCmdCtx(ctx), input.id, {
        status: input.patch.status,
        worksAmountKopecks:
          input.patch.worksAmountKopecks !== undefined
            ? BigInt(input.patch.worksAmountKopecks)
            : undefined,
        partsAmountKopecks:
          input.patch.partsAmountKopecks !== undefined
            ? BigInt(input.patch.partsAmountKopecks)
            : undefined,
        description: input.patch.description,
        rejectionReason: input.patch.rejectionReason,
      }),
    ),

  approve: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => approveKpCmd(buildCmdCtx(ctx), input.id)),

  archive: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => archiveKpCmd(buildCmdCtx(ctx), input.id)),
});
