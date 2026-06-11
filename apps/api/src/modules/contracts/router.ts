/**
 * tRPC роутер contracts.
 * RBAC:
 *   - list / get / listActiveByClient: engineerProcedure (чтобы инженер видел договор по своей заявке).
 *   - create / update / archive:        staffProcedure (диспетчер + директор).
 */
import { z } from 'zod';
import { engineerProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  archiveContractCmd,
  createContractCmd,
  getContractQuery,
  listActiveByClientQuery,
  listContractsQuery,
  updateContractCmd,
} from './service';

const contractTypeEnum = z.enum(['service', 'one_time']);
const contractStatusEnum = z.enum(['draft', 'active', 'expired', 'terminated']);
const vatRateEnum = z.enum(['0', '5', '10', '20', 'without_vat']);

/** ISO-8601 date в формате YYYY-MM-DD. */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Дата должна быть в формате YYYY-MM-DD' });

const termsSchema = z
  .object({
    performanceDays: z.number().int().min(1).max(3650).optional(),
    warrantyMonths: z.number().int().min(0).max(120).optional(),
    prepaymentPercent: z.number().min(0).max(100).optional(),
    paymentDueDays: z.number().int().min(0).max(365).optional(),
    performancePenaltyPercent: z.number().min(0).max(100).optional(),
    paymentPenaltyDailyPercent: z.number().min(0).max(10).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export const contractsRouter = router({
  list: engineerProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        status: contractStatusEnum.optional(),
        clientId: z.string().uuid().optional(),
        page: z.number().int().min(1).optional(),
      }),
    )
    .query(({ ctx, input }) => listContractsQuery(ctx.db, ctx.tenant, input)),

  get: engineerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getContractQuery(ctx.db, ctx.tenant, input.id)),

  listActiveByClient: engineerProcedure
    .input(z.object({ clientId: z.string().uuid() }))
    .query(({ ctx, input }) => listActiveByClientQuery(ctx.db, ctx.tenant, input.clientId)),

  create: staffProcedure
    .input(
      z.object({
        clientId: z.string().uuid(),
        contractNumber: z.string().trim().min(1).max(50),
        contractDate: dateString,
        type: contractTypeEnum.optional(),
        vatRate: vatRateEnum.optional(),
        status: contractStatusEnum.optional(),
        validFrom: dateString.nullable().optional(),
        validUntil: dateString.nullable().optional(),
        terms: termsSchema.optional(),
        notes: z.string().trim().max(5000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => createContractCmd(buildCmdCtx(ctx), input)),

  update: staffProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            contractNumber: z.string().trim().min(1).max(50).optional(),
            contractDate: dateString.optional(),
            type: contractTypeEnum.optional(),
            vatRate: vatRateEnum.optional(),
            status: contractStatusEnum.optional(),
            validFrom: dateString.nullable().optional(),
            validUntil: dateString.nullable().optional(),
            terms: termsSchema.optional(),
            signedPdfObjectKey: z.string().trim().max(500).nullable().optional(),
            notes: z.string().trim().max(5000).nullable().optional(),
          })
          .strict(),
      }),
    )
    .mutation(({ ctx, input }) => updateContractCmd(buildCmdCtx(ctx), input.id, input.patch)),

  archive: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => archiveContractCmd(buildCmdCtx(ctx), input.id)),
});
