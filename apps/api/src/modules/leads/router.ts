/**
 * tRPC роутер leads (воронка продаж).
 * RBAC: всё под staffProcedure (директор + диспетчер). Инженеры лиды не ведут.
 */
import { z } from 'zod';
import { LeadLostReason, LeadSource, LeadStatus } from '@erfolg/shared';
import { router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  archiveLeadCmd,
  convertLeadToClientCmd,
  createLeadCmd,
  getLeadQuery,
  leadFunnelStatsQuery,
  listLeadsQuery,
  updateLeadCmd,
} from './service';

/** ISO-8601 date YYYY-MM-DD. */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Дата должна быть в формате YYYY-MM-DD' });

const moneyInput = z.number().min(0).max(1_000_000_000_000);

const leadFields = {
  name: z.string().trim().min(1).max(255),
  contactPerson: z.string().trim().max(255).nullable().optional(),
  phone: z.string().trim().max(64).nullable().optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  address: z.string().trim().max(2000).nullable().optional(),
  region: z.string().trim().max(128).nullable().optional(),
  status: LeadStatus.optional(),
  source: LeadSource.optional(),
  estimatedValue: moneyInput.optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  nextAction: z.string().trim().max(2000).nullable().optional(),
  nextActionDate: dateString.nullable().optional(),
  lostReason: LeadLostReason.nullable().optional(),
  lostComment: z.string().trim().max(2000).nullable().optional(),
};

export const leadsRouter = router({
  list: staffProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        status: LeadStatus.optional(),
        assignedUserId: z.string().uuid().optional(),
        page: z.number().int().min(1).optional(),
      }),
    )
    .query(({ ctx, input }) => listLeadsQuery(ctx.db, ctx.tenant, input)),

  get: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getLeadQuery(ctx.db, ctx.tenant, input.id)),

  funnelStats: staffProcedure.query(({ ctx }) => leadFunnelStatsQuery(ctx.db, ctx.tenant)),

  create: staffProcedure
    .input(z.object(leadFields))
    .mutation(({ ctx, input }) => createLeadCmd(buildCmdCtx(ctx), input)),

  update: staffProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            ...leadFields,
            name: z.string().trim().min(1).max(255).optional(),
          })
          .strict(),
      }),
    )
    .mutation(({ ctx, input }) => updateLeadCmd(buildCmdCtx(ctx), input.id, input.patch)),

  archive: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => archiveLeadCmd(buildCmdCtx(ctx), input.id)),

  convertToClient: staffProcedure
    .input(
      z.object({
        leadId: z.string().uuid(),
        clientType: z.enum(['legal', 'individual']).default('legal'),
        inn: z.string().trim().max(12).nullable().optional(),
        kpp: z.string().trim().max(9).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => convertLeadToClientCmd(buildCmdCtx(ctx), input)),
});
