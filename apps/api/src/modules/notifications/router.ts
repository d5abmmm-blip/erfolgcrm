/**
 * tRPC роутер notifications. Любой залогиненый пользователь может subscribe/unsubscribe
 * для своего собственного устройства. Public key — без авторизации (нужен SW при инициализации).
 */
import { z } from 'zod';
import { authedProcedure, publicProcedure, router } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import { getPublicKeyQuery, subscribeCmd, unsubscribeCmd } from './service';

export const notificationsRouter = router({
  /** Публичный VAPID-ключ. SW использует для PushManager.subscribe. */
  publicKey: publicProcedure.query(() => getPublicKeyQuery()),

  subscribe: authedProcedure
    .input(
      z.object({
        endpoint: z.string().url().max(1024),
        p256dh: z.string().min(20).max(200),
        auth: z.string().min(20).max(200),
      }),
    )
    .mutation(({ ctx, input }) => subscribeCmd(buildCmdCtx(ctx), input)),

  unsubscribe: authedProcedure
    .input(z.object({ endpoint: z.string().url().max(1024) }))
    .mutation(({ ctx, input }) => unsubscribeCmd(buildCmdCtx(ctx), input.endpoint)),
});
