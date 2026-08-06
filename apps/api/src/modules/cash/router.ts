/**
 * tRPC роутер кассы (ДДС).
 * RBAC: чтение и операции (доход/расход/перевод) — staffProcedure (директор + диспетчер
 * ведут кассу). Управление счетами и статьями — directorProcedure.
 */
import { z } from 'zod';
import { directorProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import * as svc from './service';

const MAX_AMOUNT_RUB = 9_999_999_999;
const accountKind = z.enum(['cash', 'bank', 'card']);
const direction = z.enum(['income', 'expense']);
const txKind = z.enum(['income', 'expense', 'transfer']);
const paymentMethod = z.enum(['cash', 'card', 'bank_transfer']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата должна быть в формате YYYY-MM-DD');
const rubToKopecks = (rub: number): bigint => BigInt(Math.round(rub * 100));

const accountsRouter = router({
  list: staffProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(({ ctx, input }) =>
      svc.listAccountsQuery(ctx.db, ctx.tenant, input?.includeArchived ?? false),
    ),

  create: directorProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        kind: accountKind,
        openingBalanceRub: z.number().min(-MAX_AMOUNT_RUB).max(MAX_AMOUNT_RUB).optional(),
        defaultForMethod: paymentMethod.nullable().optional(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.createAccountCmd(buildCmdCtx(ctx), {
        name: input.name,
        kind: input.kind,
        openingBalanceKopecks:
          input.openingBalanceRub !== undefined ? rubToKopecks(input.openingBalanceRub) : undefined,
        defaultForMethod: input.defaultForMethod ?? null,
        sortOrder: input.sortOrder,
      }),
    ),

  update: directorProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        kind: accountKind.optional(),
        openingBalanceRub: z.number().min(-MAX_AMOUNT_RUB).max(MAX_AMOUNT_RUB).optional(),
        defaultForMethod: paymentMethod.nullable().optional(),
        isArchived: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.updateAccountCmd(buildCmdCtx(ctx), input.id, {
        name: input.name,
        kind: input.kind,
        openingBalanceKopecks:
          input.openingBalanceRub !== undefined ? rubToKopecks(input.openingBalanceRub) : undefined,
        defaultForMethod: input.defaultForMethod,
        isArchived: input.isArchived,
        sortOrder: input.sortOrder,
      }),
    ),

  delete: directorProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => svc.deleteAccountCmd(buildCmdCtx(ctx), input.id)),
});

const categoriesRouter = router({
  list: staffProcedure
    .input(
      z
        .object({ direction: direction.optional(), includeArchived: z.boolean().optional() })
        .optional(),
    )
    .query(({ ctx, input }) =>
      svc.listCategoriesQuery(ctx.db, ctx.tenant, {
        direction: input?.direction,
        includeArchived: input?.includeArchived,
      }),
    ),

  create: directorProcedure
    .input(z.object({ name: z.string().trim().min(1).max(120), direction }))
    .mutation(({ ctx, input }) =>
      svc.createCategoryCmd(buildCmdCtx(ctx), { name: input.name, direction: input.direction }),
    ),

  update: directorProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        isArchived: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.updateCategoryCmd(buildCmdCtx(ctx), input.id, {
        name: input.name,
        isArchived: input.isArchived,
        sortOrder: input.sortOrder,
      }),
    ),
});

const PAGE_SIZE = 50;

const transactionsRouter = router({
  list: staffProcedure
    .input(
      z.object({
        kind: txKind.optional(),
        accountId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
        clientId: z.string().uuid().optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(({ ctx, input }) => {
      const limit = input.limit ?? PAGE_SIZE;
      const page = input.page ?? 1;
      return svc.listTransactionsQuery(
        ctx.db,
        ctx.tenant,
        {
          kind: input.kind,
          accountId: input.accountId,
          categoryId: input.categoryId,
          clientId: input.clientId,
          from: input.from,
          to: input.to,
        },
        limit,
        (page - 1) * limit,
      );
    }),

  create: staffProcedure
    .input(
      z.object({
        kind: txKind,
        accountId: z.string().uuid(),
        counterAccountId: z.string().uuid().nullable().optional(),
        categoryId: z.string().uuid().nullable().optional(),
        amountRub: z.number().positive().max(MAX_AMOUNT_RUB),
        occurredOn: isoDate,
        comment: z.string().trim().max(2000).nullable().optional(),
        counterparty: z.string().trim().max(200).nullable().optional(),
        clientId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.createTransactionCmd(buildCmdCtx(ctx), {
        kind: input.kind,
        accountId: input.accountId,
        counterAccountId: input.counterAccountId ?? null,
        categoryId: input.categoryId ?? null,
        amountKopecks: rubToKopecks(input.amountRub),
        occurredOn: input.occurredOn,
        comment: input.comment ?? null,
        counterparty: input.counterparty ?? null,
        clientId: input.clientId ?? null,
        userId: ctx.session.userId,
      }),
    ),

  delete: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => svc.deleteTransactionCmd(buildCmdCtx(ctx), input.id)),
});

export const cashRouter = router({
  accounts: accountsRouter,
  categories: categoriesRouter,
  transactions: transactionsRouter,

  overview: staffProcedure
    .input(
      z
        .object({
          preset: z.enum(['today', 'week', 'month', 'quarter', 'year']).optional(),
          /** Учитывать внесения/выдачи (внутренние операции) в сводках. По умолчанию — нет. */
          includeInternal: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      svc.overviewQuery(
        ctx.db,
        ctx.tenant,
        input?.preset ?? 'month',
        input?.includeInternal ?? false,
      ),
    ),

  /** Внесение в кассу / выдача из кассы — внутренняя операция (не доход/расход бизнеса). */
  internalAdd: staffProcedure
    .input(
      z.object({
        kind: z.enum(['deposit', 'withdrawal']),
        accountId: z.string().uuid(),
        amountRub: z.number().positive().max(MAX_AMOUNT_RUB),
        occurredOn: isoDate,
        counterparty: z.string().trim().max(200).nullable().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      svc.createInternalCmd(buildCmdCtx(ctx), {
        kind: input.kind,
        accountId: input.accountId,
        amountKopecks: rubToKopecks(input.amountRub),
        occurredOn: input.occurredOn,
        counterparty: input.counterparty ?? null,
        comment: input.comment ?? null,
      }),
    ),
});
