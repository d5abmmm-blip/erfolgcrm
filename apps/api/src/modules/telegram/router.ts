/**
 * tRPC роутер telegram.
 * Настройка бота — только директор. Привязка своего чата — любой сотрудник
 * (engineerProcedure); staff может выпускать код привязки для любого сотрудника
 * (карточка сотрудника → «Привязать Telegram»).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { users, withTenantTx, type Db } from '@erfolg/db';
import { directorProcedure, engineerProcedure, router } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import { disableCmd, getConfigQuery, setConfigCmd } from './service';
import { getPublicConfig } from './repository';
import { createLinkCode, isChatLinked, unlinkChat } from './staff-link';

export const telegramRouter = router({
  getConfig: directorProcedure.query(({ ctx }) =>
    getConfigQuery({ db: ctx.db, tenant: ctx.tenant }),
  ),

  setConfig: directorProcedure
    .input(
      z.object({
        botToken: z
          .string()
          .trim()
          .regex(/^\d+:[A-Za-z0-9_-]+$/, {
            message: 'Неверный формат токена. Получите токен у @BotFather.',
          }),
        defaultDispatcherUserId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => setConfigCmd(buildCmdCtx(ctx), input)),

  disable: directorProcedure.mutation(({ ctx }) => disableCmd(buildCmdCtx(ctx))),

  /** Статус привязки Telegram: свой — любой сотрудник; чужой — только staff. */
  linkStatus: engineerProcedure
    .input(z.object({ userId: z.string().uuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const targetUserId = await resolveTargetUserId(
        ctx.db,
        ctx.tenant.id,
        ctx.session,
        input?.userId,
      );
      const [linked, cfg] = await Promise.all([
        isChatLinked(ctx.db, ctx.tenant.id, targetUserId),
        getPublicConfig(ctx.db, ctx.tenant),
      ]);
      return {
        linked,
        botEnabled: Boolean(cfg?.enabled && cfg.hasToken),
        botUsername: cfg?.botUsername ?? null,
      };
    }),

  /** Одноразовый код привязки (TTL 15 мин) + готовая deep-link на бота. */
  createLinkCode: engineerProcedure
    .input(z.object({ userId: z.string().uuid().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const targetUserId = await resolveTargetUserId(
        ctx.db,
        ctx.tenant.id,
        ctx.session,
        input?.userId,
      );
      const cfg = await getPublicConfig(ctx.db, ctx.tenant);
      if (!cfg?.enabled || !cfg.hasToken || !cfg.botUsername) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Telegram-бот не подключён. Директор может подключить его в Настройках → Telegram.',
        });
      }
      const code = await createLinkCode(ctx.tenant.id, targetUserId);
      return {
        code,
        deepLink: `https://t.me/${cfg.botUsername}?start=link_${code}`,
        botUsername: cfg.botUsername,
        ttlMinutes: 15,
      };
    }),

  /** Отвязать Telegram: свой — любой сотрудник; чужой — только staff. */
  unlink: engineerProcedure
    .input(z.object({ userId: z.string().uuid().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const targetUserId = await resolveTargetUserId(
        ctx.db,
        ctx.tenant.id,
        ctx.session,
        input?.userId,
      );
      await unlinkChat(ctx.db, ctx.tenant.id, targetUserId);
      return { ok: true as const };
    }),
});

/**
 * Чью привязку можно трогать: свою — любой; чужую — staff, но диспетчер только
 * ИНЖЕНЕРСКУЮ (иначе диспетчер мог бы привязать свой Telegram к аккаунту
 * директора и реагировать на заявки от его имени). Директор — любую.
 */
async function resolveTargetUserId(
  db: Db,
  tenantId: string,
  session: { userId: string; role: 'director' | 'dispatcher' | 'engineer' },
  requestedUserId: string | undefined,
): Promise<string> {
  if (!requestedUserId || requestedUserId === session.userId) return session.userId;
  if (session.role === 'engineer') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Инженер управляет только своей привязкой' });
  }
  if (session.role === 'dispatcher') {
    const rows = await withTenantTx(db, tenantId, (tx) =>
      tx.select({ role: users.role }).from(users).where(eq(users.id, requestedUserId)).limit(1),
    );
    if (rows[0]?.role !== 'engineer') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Диспетчер управляет привязками только инженеров',
      });
    }
  }
  return requestedUserId;
}
