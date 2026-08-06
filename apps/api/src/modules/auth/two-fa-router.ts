/**
 * Stage 10'.C — auth.twoFactor.* — управление 2FA для текущего пользователя.
 *
 * setup.start    — генерирует TOTP secret + otpauthUrl, НЕ пишет в БД.
 * setup.confirm  — проверяет код для secret, шифрует и сохраняет, выдаёт recovery-коды (1 раз).
 * disable        — отключает 2FA (нужно подтвердить пароль + текущий TOTP).
 * regenerateRecoveryCodes — перевыпускает 10 кодов (нужно password + TOTP).
 *
 * Доступно директору. Остальные роли пока не используют 2FA на UI, но процедуры
 * не запрещены — если понадобится, можно убрать ограничение.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { verify } from 'argon2';
import { users, withTenantTx } from '@erfolg/db';
import { directorProcedure, router } from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import {
  buildOtpauthUrl,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCodes,
  verifyTotp,
} from './totp';
import {
  disableTwoFactor,
  enableTwoFactor,
  readTotpSecret,
  replaceRecoveryHashes,
} from './two-factor';

const setup = router({
  start: directorProcedure.mutation(({ ctx }) => {
    const secret = generateTotpSecret();
    const otpauthUrl = buildOtpauthUrl(secret, ctx.session.username);
    return { secret, otpauthUrl };
  }),

  confirm: directorProcedure
    .input(
      z.object({
        secret: z.string().min(16).max(128),
        code: z.string().min(6).max(8),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!verifyTotp(input.secret, input.code)) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Код не совпадает. Проверьте время на телефоне и попробуйте ещё раз.',
        });
      }
      // Если 2FA уже включена — не даём переписать сверху без disable.
      const [current] = await withTenantTx(ctx.db, ctx.tenant.id, (tx) =>
        tx
          .select({ enabledAt: users.totpEnabledAt })
          .from(users)
          .where(and(eq(users.id, ctx.session.userId), isNull(users.deletedAt)))
          .limit(1),
      );
      if (current?.enabledAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: '2FA уже включена. Отключите её перед повторной настройкой.',
        });
      }

      const recoveryCodes = generateRecoveryCodes();
      const hashes = await hashRecoveryCodes(recoveryCodes);
      await enableTwoFactor(ctx.db, ctx.tenant, ctx.session.userId, input.secret, hashes);

      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'user',
        entityId: ctx.session.userId,
        context: { '2fa': 'enabled' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      // Открытые коды показываются один раз — клиент обязан сохранить.
      return { recoveryCodes };
    }),
});

interface RequireCtx {
  db: Parameters<typeof withTenantTx>[0];
  tenant: { id: string; kmsKeyId: string | null };
  session: { userId: string };
}

async function requirePasswordAndTotp(
  ctx: RequireCtx,
  password: string,
  code: string,
): Promise<void> {
  const [user] = await withTenantTx(ctx.db, ctx.tenant.id, (tx) =>
    tx
      .select()
      .from(users)
      .where(and(eq(users.id, ctx.session.userId), isNull(users.deletedAt)))
      .limit(1),
  );
  if (!user) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
  }
  const passOk = await verify(user.passwordHash, password);
  if (!passOk) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Неверный пароль' });
  }
  const totp = await readTotpSecret(ctx.db, ctx.tenant, user.id);
  if (!totp || !totp.secret) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '2FA не включена' });
  }
  if (!verifyTotp(totp.secret, code)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Неверный код' });
  }
}

const disable = directorProcedure
  .input(
    z.object({
      password: z.string().min(1).max(200),
      code: z.string().min(6).max(8),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    await requirePasswordAndTotp(ctx, input.password, input.code);
    await disableTwoFactor(ctx.db, ctx.tenant.id, ctx.session.userId);
    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'update',
      entityType: 'user',
      entityId: ctx.session.userId,
      context: { '2fa': 'disabled' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: true };
  });

const regenerateRecoveryCodes = directorProcedure
  .input(
    z.object({
      password: z.string().min(1).max(200),
      code: z.string().min(6).max(8),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    await requirePasswordAndTotp(ctx, input.password, input.code);
    const recoveryCodes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(recoveryCodes);
    await replaceRecoveryHashes(ctx.db, ctx.tenant.id, ctx.session.userId, hashes);
    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'update',
      entityType: 'user',
      entityId: ctx.session.userId,
      context: { '2fa': 'recovery_regenerated' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { recoveryCodes };
  });

export const twoFactorRouter = router({
  setup,
  disable,
  regenerateRecoveryCodes,
});
