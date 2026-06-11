/**
 * tRPC роутер tradeIn. RBAC: всё под staffProcedure (продажи/закупки — не инженерная зона).
 * Суммы принимаются в копейках (целое ≥ 0), конвертируются в bigint.
 */
import { z } from 'zod';
import { TradeInCondition, TradeInStatus } from '@erfolg/shared';
import { router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  archiveTradeInCmd,
  completeTradeInCmd,
  createTradeInCmd,
  getTradeInQuery,
  listTradeInsQuery,
  tradeInStatsQuery,
  updateTradeInCmd,
} from './service';

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Дата должна быть в формате YYYY-MM-DD' });

const kopecks = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Статусы, доступные через update; sold — только через complete. */
const editableStatus = TradeInStatus.exclude(['sold']);

const baseFields = {
  name: z.string().trim().min(1).max(255),
  manufacturer: z.string().trim().max(200).nullable().optional(),
  model: z.string().trim().max(200).nullable().optional(),
  serialNumber: z.string().trim().max(100).nullable().optional(),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  condition: TradeInCondition.optional(),
  clientId: z.string().uuid().nullable().optional(),
  assetId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
};

export const tradeInRouter = router({
  list: staffProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        status: TradeInStatus.optional(),
        page: z.number().int().min(1).optional(),
      }),
    )
    .query(({ ctx, input }) => listTradeInsQuery(ctx.db, ctx.tenant, input)),

  get: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getTradeInQuery(ctx.db, ctx.tenant, input.id)),

  stats: staffProcedure.query(({ ctx }) => tradeInStatsQuery(ctx.db, ctx.tenant)),

  create: staffProcedure
    .input(
      z.object({
        ...baseFields,
        purchasePriceKopecks: kopecks.default(0),
        assessedPriceKopecks: kopecks.default(0),
        receivedAt: dateString,
      }),
    )
    .mutation(({ ctx, input }) =>
      createTradeInCmd(buildCmdCtx(ctx), {
        ...input,
        purchasePriceKopecks: BigInt(input.purchasePriceKopecks),
        assessedPriceKopecks: BigInt(input.assessedPriceKopecks),
      }),
    ),

  update: staffProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            ...baseFields,
            name: z.string().trim().min(1).max(255).optional(),
            status: editableStatus.optional(),
            buyerClientId: z.string().uuid().nullable().optional(),
            purchasePriceKopecks: kopecks.optional(),
            assessedPriceKopecks: kopecks.optional(),
            salePriceKopecks: kopecks.nullable().optional(),
            receivedAt: dateString.optional(),
          })
          .strict(),
      }),
    )
    .mutation(({ ctx, input }) =>
      updateTradeInCmd(buildCmdCtx(ctx), input.id, {
        ...input.patch,
        purchasePriceKopecks:
          input.patch.purchasePriceKopecks !== undefined
            ? BigInt(input.patch.purchasePriceKopecks)
            : undefined,
        assessedPriceKopecks:
          input.patch.assessedPriceKopecks !== undefined
            ? BigInt(input.patch.assessedPriceKopecks)
            : undefined,
        salePriceKopecks:
          input.patch.salePriceKopecks === undefined
            ? undefined
            : input.patch.salePriceKopecks === null
              ? null
              : BigInt(input.patch.salePriceKopecks),
      }),
    ),

  /** Завершение сделки: продано покупателю (+ перенос владельца привязанной техники). */
  complete: staffProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        salePriceKopecks: kopecks.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      completeTradeInCmd(buildCmdCtx(ctx), {
        id: input.id,
        salePriceKopecks:
          input.salePriceKopecks !== undefined ? BigInt(input.salePriceKopecks) : undefined,
      }),
    ),

  archive: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => archiveTradeInCmd(buildCmdCtx(ctx), input.id)),
});
