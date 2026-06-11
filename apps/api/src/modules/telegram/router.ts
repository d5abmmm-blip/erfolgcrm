/**
 * tRPC роутер telegram. Только для директора (RBAC).
 */
import { z } from 'zod';
import { directorProcedure, router } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import { disableCmd, getConfigQuery, setConfigCmd } from './service';

export const telegramRouter = router({
  getConfig: directorProcedure.query(({ ctx }) => getConfigQuery({ db: ctx.db, tenant: ctx.tenant })),

  setConfig: directorProcedure
    .input(
      z.object({
        botToken: z
          .string()
          .trim()
          .regex(/^\d+:[A-Za-z0-9_-]+$/, { message: 'Неверный формат токена. Получите токен у @BotFather.' }),
        defaultDispatcherUserId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => setConfigCmd(buildCmdCtx(ctx), input)),

  disable: directorProcedure.mutation(({ ctx }) => disableCmd(buildCmdCtx(ctx))),
});
