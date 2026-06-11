/**
 * tRPC контекст. Здесь резолвится tenant и сессия — это ТОЧКА ЗАЩИТЫ
 * от утечек между tenant'ами.
 *
 * Логика:
 * 1. Резолвим tenant из subdomain или X-Tenant-Subdomain header.
 *    Если tenant не найден или suspended — ctx.tenant = null. Procedures сами
 *    решают пускать или нет (publicProcedure пускает, tenantProcedure — нет).
 * 2. Резолвим сессию из cookie session_token (через Redis).
 *    Проверяем что session.tenantId == tenant.id (защита от подмены tenant'а
 *    с действующей сессией другого tenant'а).
 */
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { getDb } from '@erfolg/db';
import { resolveTenant, type ResolvedTenant } from '../lib/tenant';
import { getSession, touchSession, type SessionData } from '../lib/session';
import { logger } from '../lib/logger';
import { resolveClientSession, type ResolvedClientSession } from '../modules/client-cabinet/repository';

export interface Context {
  db: ReturnType<typeof getDb>;
  tenant: ResolvedTenant | null;
  session: SessionData | null;
  /** Stage 10'.H — кабинет клиента. NULL если не залогинен как клиент. */
  clientUser: ResolvedClientSession | null;
  ip: string;
  userAgent: string | undefined;
  /** Сырой Express response — нужен auth-роутеру для установки cookie */
  res: CreateExpressContextOptions['res'];
}

export async function createContext({ req, res }: CreateExpressContextOptions): Promise<Context> {
  const db = getDb();
  const tenant = await resolveTenant(db, req);

  const cookieToken = (req.cookies as Record<string, string> | undefined)?.session_token;
  let session: SessionData | null = null;
  if (cookieToken && tenant) {
    const candidate = await getSession(cookieToken);
    // Защита от подмены tenant'а: сессия валидна только для своего tenant'а
    if (candidate && candidate.tenantId === tenant.id) {
      session = candidate;
      // Rolling refresh: продлеваем TTL «по активности» (152-ФЗ, ст.19).
      // Не блокируем основной поток — ошибки внутри логируются, но не валят запрос.
      void touchSession(db, cookieToken).catch((err) =>
        logger.warn({ err }, 'touchSession failed'),
      );
    } else if (candidate && candidate.tenantId !== tenant.id) {
      logger.warn(
        { sessionTenantId: candidate.tenantId, requestTenantId: tenant.id, ip: req.ip },
        'Session/tenant mismatch — rejected',
      );
    }
  }

  // Stage 10'.H — клиентская сессия (отдельный cookie)
  let clientUser = null as Awaited<ReturnType<typeof resolveClientSession>>;
  if (!session) {
    const clientCookie = (req.cookies as Record<string, string> | undefined)?.client_session_token;
    if (clientCookie && tenant) {
      const candidate = await resolveClientSession(db, clientCookie);
      if (candidate && candidate.tenantId === tenant.id) {
        clientUser = candidate;
      } else if (candidate && candidate.tenantId !== tenant.id) {
        logger.warn(
          { sessionTenantId: candidate.tenantId, requestTenantId: tenant.id, ip: req.ip },
          'Client session/tenant mismatch — rejected',
        );
      }
    }
  }

  return {
    db,
    tenant,
    session,
    clientUser,
    ip: req.ip ?? '0.0.0.0',
    userAgent: req.header('user-agent'),
    res,
  };
}
