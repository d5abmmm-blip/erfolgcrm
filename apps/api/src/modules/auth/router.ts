/**
 * Auth-роутер. Login по (tenant + username + password) → cookie session_token.
 *
 * Безопасность:
 * - Argon2id для хеширования.
 * - Универсальное сообщение об ошибке (не подсказываем "username не найден" vs "пароль неверный").
 * - Лог всех login_failed в AuditLog (для будущей защиты от brute-force).
 * - Cookie httpOnly + sameSite=Lax + secure в production.
 * - Все запросы к tenant-таблицам обёрнуты в withTenantTx → RLS защищает.
 *
 * Stage 10'.C — 2FA TOTP. Если у пользователя включена 2FA, login возвращает
 * needs2fa+challengeToken, а сессия создаётся только после auth.verify2fa.
 * Подмодули:
 *   ./totp.ts        — генерация секрета, проверка TOTP, recovery-коды.
 *   ./challenge.ts   — HMAC-подписанный challenge-token + rate-limit.
 *   ./two-factor.ts  — БД-операции с зашифрованным секретом и хешами.
 *   ./two-fa-router.ts — процедуры setup/verify/disable/regenerate.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { users, withTenantTx } from '@erfolg/db';
import { verify } from 'argon2';
import { z } from 'zod';
import { router, publicProcedure, tenantProcedure, authedProcedure } from '../../trpc/trpc';
import { createSession, revokeSession } from '../../lib/session';
import { logger } from '../../lib/logger';
import { writeAudit } from '../../lib/audit';
import { issueChallengeToken } from './challenge';
import { twoFactorRouter } from './two-fa-router';
import { verify2faProcedure } from './verify2fa';

const SESSION_COOKIE = 'session_token';
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // 30 дней

export const authRouter = router({
  /**
   * Логин: проверяет пароль.
   * Если 2FA выключена → создаёт сессию, ставит cookie.
   * Если 2FA включена   → возвращает { needs2fa: true, challengeToken } БЕЗ cookie.
   */
  login: tenantProcedure
    .input(
      z.object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.tenant.id;
      const username = input.username.toLowerCase();

      const user = await withTenantTx(ctx.db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(users)
          .where(and(eq(users.username, username), isNull(users.deletedAt)))
          .limit(1);
        return rows[0];
      });

      const FAIL = new TRPCError({ code: 'UNAUTHORIZED', message: 'Неверный логин или пароль' });

      if (!user || !user.isActive) {
        await writeAudit(ctx.db, tenantId, {
          userId: null,
          action: 'login_failed',
          entityType: 'user',
          entityId: username,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          context: { reason: user ? 'inactive' : 'unknown_user' },
        });
        throw FAIL;
      }

      const ok = await verify(user.passwordHash, input.password);
      if (!ok) {
        await writeAudit(ctx.db, tenantId, {
          userId: user.id,
          action: 'login_failed',
          entityType: 'user',
          entityId: user.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          context: { reason: 'wrong_password' },
        });
        throw FAIL;
      }

      // 2FA включена → выдаём challenge, не создаём сессию.
      if (user.totpEnabledAt) {
        const { token: challengeToken } = issueChallengeToken(user.id, tenantId);
        return {
          needs2fa: true as const,
          challengeToken,
        };
      }

      const { token } = await createSession(
        ctx.db,
        {
          tenantId,
          userId: user.id,
          username: user.username,
          role: user.role,
          fullName: user.fullName,
        },
        { ip: ctx.ip, userAgent: ctx.userAgent },
      );

      await withTenantTx(ctx.db, tenantId, async (tx) => {
        await tx
          .update(users)
          .set({ lastLoginAt: new Date(), lastLoginIp: ctx.ip })
          .where(eq(users.id, user.id));
      });

      await writeAudit(ctx.db, tenantId, {
        userId: user.id,
        action: 'login',
        entityType: 'user',
        entityId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      const isProd = process.env.NODE_ENV === 'production';
      // sameSite=strict в проде — защита от CSRF через сторонние <form action>;
      // в dev оставляем lax, иначе кросс-доменные запросы localhost:5173→3030 ломаются.
      ctx.res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: isProd ? 'strict' : 'lax',
        secure: isProd,
        maxAge: COOKIE_MAX_AGE,
        path: '/',
      });

      logger.info({ tenantId, userId: user.id }, 'login ok');
      return {
        needs2fa: false as const,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.fullName,
          role: user.role,
          position: user.position,
        },
        tenant: { id: ctx.tenant.id, subdomain: ctx.tenant.subdomain, displayName: ctx.tenant.displayName },
      };
    }),

  /** Stage 10'.C — второй шаг логина: TOTP-код или recovery-код. */
  verify2fa: verify2faProcedure,

  /** Stage 10'.C — управление 2FA (setup/disable/regenerate). */
  twoFactor: twoFactorRouter,

  /** Выход: убивает сессию и cookie. */
  logout: authedProcedure.mutation(async ({ ctx }) => {
    const token = (ctx.res.req.cookies as Record<string, string>)?.session_token;
    if (token) await revokeSession(ctx.db, ctx.session.tenantId, token);
    await writeAudit(ctx.db, ctx.session.tenantId, {
      userId: ctx.session.userId,
      action: 'logout',
      entityType: 'user',
      entityId: ctx.session.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    ctx.res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }),

  /** Текущий пользователь. Возвращает null если не залогинен. */
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.tenant || !ctx.session) return null;
    // Подтянем флаг включена ли 2FA — нужен для UI.
    const tenantId = ctx.session.tenantId;
    const userId = ctx.session.userId;
    const [row] = await withTenantTx(ctx.db, tenantId, async (tx) =>
      tx
        .select({ enabledAt: users.totpEnabledAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    return {
      user: {
        id: ctx.session.userId,
        username: ctx.session.username,
        fullName: ctx.session.fullName,
        role: ctx.session.role,
        twoFactorEnabled: !!row?.enabledAt,
      },
      tenant: {
        id: ctx.tenant.id,
        subdomain: ctx.tenant.subdomain,
        displayName: ctx.tenant.displayName,
      },
    };
  }),
});
