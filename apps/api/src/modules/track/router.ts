/**
 * tRPC роутер публичного трека «как посылка» (фича №3).
 *
 * getByToken — БЕЗ авторизации (tenantProcedure: tenant по домену/subdomain, логин не
 * нужен). Токен-секрет = единственный ключ. Неизвестный/отозванный токен → NOT_FOUND
 * (не подтверждаем существование заявки). Отдаём только PII-free таймлайн.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, tenantProcedure } from '../../trpc/trpc';
import { trackByTokenQuery } from './service';

export const trackRouter = router({
  getByToken: tenantProcedure
    .input(z.object({ token: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const dto = await trackByTokenQuery(
        ctx.db,
        ctx.tenant.id,
        ctx.tenant.displayName,
        input.token,
      );
      if (!dto) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Ссылка не найдена или устарела' });
      }
      return dto;
    }),
});
