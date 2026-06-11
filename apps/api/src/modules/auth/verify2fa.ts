/**
 * Stage 10'.C — auth.verify2fa: второй шаг логина.
 *
 * Принимает challengeToken (от auth.login) + 6-значный TOTP или 12-символьный
 * recovery-код. При успехе создаёт session, ставит cookie и пишет AuditLog 'login'
 * с context.method = 'totp' | 'recovery'.
 *
 * Защита:
 *   - challengeToken HMAC-подписан, TTL 5 мин (см. ./challenge.ts).
 *   - rate-limit 5 попыток/мин per challenge-jti (in-memory).
 *   - При неуспехе пишется AuditLog 'login_failed'.
 *   - Recovery-код одноразовый: при успешной проверке хеш удаляется из массива.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { users, withTenantTx, type Db } from '@erfolg/db';
import { tenantProcedure } from '../../trpc/trpc';
import { createSession } from '../../lib/session';
import { writeAudit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { checkAttempt, clearAttempts, verifyChallengeToken } from './challenge';
import { looksLikeRecoveryCode, verifyRecoveryCode, verifyTotp } from './totp';
import { readTotpSecret, replaceRecoveryHashes } from './two-factor';

const SESSION_COOKIE = 'session_token';
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 30;

interface AuditCtx {
  db: Db;
  ip: string;
  userAgent: string | undefined;
}

async function auditFailed(
  ctx: AuditCtx,
  tenantId: string,
  userId: string | null,
  reason: string,
  method: 'totp' | 'recovery' | 'unknown',
): Promise<void> {
  await writeAudit(ctx.db, tenantId, {
    userId,
    action: 'login_failed',
    entityType: 'user',
    entityId: userId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    context: { method, reason, stage: '2fa' },
  });
}

export const verify2faProcedure = tenantProcedure
  .input(
    z.object({
      challengeToken: z.string().min(10).max(500),
      code: z.string().min(4).max(32),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const tenantId = ctx.tenant.id;
    const FAIL = new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Неверный код. Попробуйте ещё раз.',
    });

    const payload = verifyChallengeToken(input.challengeToken);
    if (!payload || payload.tenantId !== tenantId) {
      await auditFailed(ctx, tenantId, null, 'bad_challenge', 'unknown');
      throw FAIL;
    }
    if (!checkAttempt(payload.jti)) {
      await auditFailed(ctx, tenantId, payload.userId, 'rate_limited', 'unknown');
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Слишком много попыток. Подождите минуту.',
      });
    }

    const user = await withTenantTx(ctx.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, payload.userId), isNull(users.deletedAt)))
        .limit(1);
      return rows[0];
    });
    if (!user || !user.isActive || !user.totpEnabledAt) {
      await auditFailed(ctx, tenantId, payload.userId, 'no_2fa', 'unknown');
      throw FAIL;
    }

    const isRecovery = looksLikeRecoveryCode(input.code);
    const method: 'totp' | 'recovery' = isRecovery ? 'recovery' : 'totp';

    const secretRow = await readTotpSecret(ctx.db, ctx.tenant, user.id);
    if (!secretRow || !secretRow.secret) {
      await auditFailed(ctx, tenantId, user.id, 'no_secret', method);
      throw FAIL;
    }

    let success = false;
    if (isRecovery) {
      const hitIndex = await verifyRecoveryCode(input.code, secretRow.recoveryHashes);
      if (hitIndex !== null) {
        const remaining = secretRow.recoveryHashes.filter((_, i) => i !== hitIndex);
        await replaceRecoveryHashes(ctx.db, tenantId, user.id, remaining);
        success = true;
      }
    } else {
      success = verifyTotp(secretRow.secret, input.code);
    }

    if (!success) {
      await auditFailed(ctx, tenantId, user.id, 'wrong_code', method);
      throw FAIL;
    }

    clearAttempts(payload.jti);

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
      context: { method },
    });

    const isProd = process.env.NODE_ENV === 'production';
    // sameSite=strict в проде — защита от CSRF; в dev lax для localhost cross-port.
    ctx.res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: isProd ? 'strict' : 'lax',
      secure: isProd,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });
    logger.info({ tenantId, userId: user.id, method }, '2fa login ok');

    return {
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        position: user.position,
      },
      tenant: {
        id: ctx.tenant.id,
        subdomain: ctx.tenant.subdomain,
        displayName: ctx.tenant.displayName,
      },
    };
  });
