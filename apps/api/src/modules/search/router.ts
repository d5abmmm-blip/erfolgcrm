/**
 * tRPC роутер глобального поиска.
 *
 * RBAC: authedProcedure — доступно всем staff (директор/диспетчер/инженер).
 * Кабинет клиента имеет свой namespace и сюда не ходит.
 */
import { z } from 'zod';
import { router, authedProcedure } from '../../trpc/trpc';
import { searchEverything } from './repository';

export const searchRouter = router({
  global: authedProcedure
    .input(
      z.object({
        query: z.string().trim().max(100),
      }),
    )
    .query(({ ctx, input }) =>
      searchEverything(ctx.db, ctx.tenant.id, input.query, ctx.session.role),
    ),
});
