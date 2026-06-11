import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import type { Context } from './context';

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * tenantProcedure — гарантирует, что в контексте есть валидный активный tenant.
 * Используется ВСЕМИ роутерами кроме control-plane.
 * Это первая линия защиты от cross-tenant data leak.
 */
export const tenantProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.tenant) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Tenant не найден' });
  }
  if (ctx.tenant.status === 'suspended' || ctx.tenant.status === 'cancelled') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Tenant заблокирован' });
  }
  return next({ ctx: { ...ctx, tenant: ctx.tenant } });
});

/**
 * authedProcedure — требует залогиненного пользователя.
 * Гарантирует ctx.session !== null.
 */
export const authedProcedure = tenantProcedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Требуется вход' });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

/**
 * Хелпер для роль-специфичных procedures.
 * Использование:
 *   export const directorProcedure = roleProcedure(['director']);
 *   export const staffProcedure = roleProcedure(['director', 'dispatcher']);
 */
export function roleProcedure(allowed: Array<'director' | 'dispatcher' | 'engineer'>) {
  return authedProcedure.use(({ ctx, next }) => {
    if (!allowed.includes(ctx.session.role)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Доступ только для ролей: ${allowed.join(', ')}`,
      });
    }
    return next({ ctx });
  });
}

export const directorProcedure = roleProcedure(['director']);
export const staffProcedure = roleProcedure(['director', 'dispatcher']);
export const engineerProcedure = roleProcedure(['director', 'dispatcher', 'engineer']);

/**
 * Stage 10'.H — clientUserProcedure: для эндпоинтов кабинета клиента.
 * Гарантирует ctx.clientUser !== null. Это ОТДЕЛЬНЫЙ namespace от staff,
 * у клиентов нет ролей director/dispatcher/engineer.
 */
export const clientUserProcedure = tenantProcedure.use(({ ctx, next }) => {
  if (!ctx.clientUser) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Требуется вход в кабинет клиента' });
  }
  return next({ ctx: { ...ctx, clientUser: ctx.clientUser } });
});
