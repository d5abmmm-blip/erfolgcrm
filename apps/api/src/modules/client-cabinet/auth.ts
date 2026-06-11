/**
 * Login/logout/me для кабинета клиента (Stage 10'.H).
 *
 * Cookie name = "client_session_token" (отдельно от staff session_token,
 * чтобы директор и клиент могли быть залогинены одновременно из одного браузера).
 *
 * Безопасность:
 *   • argon2id verify
 *   • universal error message (нельзя отличить «нет такого email» от «неверный пароль»)
 *   • blocked-account → FORBIDDEN с явным текстом
 *   • AuditLog на каждой login-попытке
 */
import { TRPCError } from '@trpc/server';
import { verify } from 'argon2';
import { writeAudit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import {
  CLIENT_SESSION_TTL_SECONDS,
  createClientSession,
  findClientUserByEmail,
  getClientDisplayName,
  recordClientConsentIfMissing,
  revokeClientSession,
} from './repository';
import type { Db } from '@erfolg/db';

const CLIENT_SESSION_COOKIE = 'client_session_token';
// Cookie = серверный TTL (7 дней); rolling-продление — в trpc/context.ts.
const COOKIE_MAX_AGE = CLIENT_SESSION_TTL_SECONDS * 1000;

interface LoginCtx {
  db: Db;
  tenantId: string;
  ip: string;
  userAgent: string | undefined;
  res: { cookie: (name: string, value: string, opts: Record<string, unknown>) => void };
}

export interface LoginResult {
  user: {
    id: string;
    email: string;
    fullName: string;
    position: string | null;
    clientId: string;
    clientDisplayName: string | null;
  };
  tenant: { subdomain: string; displayName: string };
}

const FAIL = new TRPCError({ code: 'UNAUTHORIZED', message: 'Неверный email или пароль' });

export async function loginClient(
  ctx: LoginCtx & { tenantSubdomain: string; tenantDisplayName: string },
  input: { email: string; password: string },
): Promise<LoginResult> {
  const user = await findClientUserByEmail(ctx.db, ctx.tenantId, input.email);
  if (!user) {
    await writeAudit(ctx.db, ctx.tenantId, {
      userId: null,
      action: 'login_failed',
      entityType: 'client_user',
      entityId: input.email.trim().toLowerCase(),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      context: { reason: 'unknown_email', client_email: input.email.trim().toLowerCase() },
    });
    throw FAIL;
  }
  if (!user.isActive) {
    await writeAudit(ctx.db, ctx.tenantId, {
      userId: null,
      action: 'login_failed',
      entityType: 'client_user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      context: { reason: 'inactive', client_user_id: user.id, client_email: user.email },
    });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Учётная запись заблокирована. Обратитесь в сервисный центр.',
    });
  }

  const ok = await verify(user.passwordHash, input.password);
  if (!ok) {
    await writeAudit(ctx.db, ctx.tenantId, {
      userId: null,
      action: 'login_failed',
      entityType: 'client_user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      context: { reason: 'wrong_password', client_user_id: user.id, client_email: user.email },
    });
    throw FAIL;
  }

  const { token } = await createClientSession(ctx.db, ctx.tenantId, user.id, {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  // 152-ФЗ: фиксируем согласие на обработку ПДн при первом входе.
  // Идемпотентно — уже активные согласия не дублируются.
  const consentInserted = await recordClientConsentIfMissing(
    ctx.db,
    ctx.tenantId,
    user.id,
    { ip: ctx.ip, userAgent: ctx.userAgent },
  );
  if (consentInserted) {
    await writeAudit(ctx.db, ctx.tenantId, {
      userId: null,
      action: 'consent_given',
      entityType: 'client_user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      context: {
        client_user_id: user.id,
        consent_type: 'pdn_processing',
        policy_version: '1.0',
      },
    });
  }

  await writeAudit(ctx.db, ctx.tenantId, {
    userId: null,
    action: 'login',
    entityType: 'client_user',
    entityId: user.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    context: { client_user_id: user.id, client_email: user.email },
  });

  const isProd = process.env.NODE_ENV === 'production';
  // sameSite=strict в проде — защита от CSRF; в dev lax для localhost cross-port.
  ctx.res.cookie(CLIENT_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: isProd ? 'strict' : 'lax',
    secure: isProd,
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });

  const clientDisplayName = await getClientDisplayName(
    ctx.db,
    ctx.tenantId,
    user.clientId,
  );

  logger.info({ tenantId: ctx.tenantId, clientUserId: user.id }, 'client login ok');

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      position: user.position,
      clientId: user.clientId,
      clientDisplayName,
    },
    tenant: { subdomain: ctx.tenantSubdomain, displayName: ctx.tenantDisplayName },
  };
}

export async function logoutClient(
  db: Db,
  tenantId: string,
  cookieValue: string | undefined,
  meta: {
    res: { clearCookie: (name: string, opts?: Record<string, unknown>) => void };
    clientUserId: string;
    ip: string;
    userAgent: string | undefined;
  },
): Promise<void> {
  if (cookieValue) await revokeClientSession(db, tenantId, cookieValue);
  await writeAudit(db, tenantId, {
    userId: null,
    action: 'logout',
    entityType: 'client_user',
    entityId: meta.clientUserId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    context: { client_user_id: meta.clientUserId },
  });
  meta.res.clearCookie(CLIENT_SESSION_COOKIE, { path: '/' });
}

export const CLIENT_COOKIE_NAME = CLIENT_SESSION_COOKIE;
