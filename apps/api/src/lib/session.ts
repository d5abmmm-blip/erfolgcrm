/**
 * Сессии хранятся в Redis для скорости + дублируются в БД для аудита и принудительного logout.
 * Cookie содержит session_token (uuid v7), httpOnly, signed.
 *
 * Логика:
 * - createSession() → генерирует token, кладёт в Redis с TTL, пишет в БД таблицу sessions.
 * - getSession(token) → читает из Redis. Не лезет в БД на каждый запрос.
 * - touchSession(token) → продлевает TTL на полный срок (rolling/sliding refresh).
 *   Вызывается из контекста tRPC при каждом успешном запросе.
 * - revokeSession(token) → удаляет из Redis + помечает в БД revokedAt.
 *
 * 152-ФЗ ст.19 + рекомендации ФСТЭК — короткое время жизни сессии (≤7 дней)
 * с продлением "по активности" вместо длинных постоянных сессий.
 *
 * Все БД-операции через withTenantTx (sessions под RLS).
 */
import { eq } from 'drizzle-orm';
import { sessions, withTenantTx, type Db } from '@erfolg/db';
import { uuidv7 } from 'uuidv7';
import { getRedis } from './redis';

export interface SessionData {
  tenantId: string;
  userId: string;
  username: string;
  role: 'director' | 'dispatcher' | 'engineer';
  fullName: string;
  expiresAt: number; // unix ms
}

/** 7 дней — окно активности. При активной работе обновляется через touchSession. */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
/** Минимальный «зазор» в Redis-TTL до полного обновления. Чтобы не слать UPDATE на каждый запрос
 * за миллисекунду до конца окна. Если оставшийся TTL ≥ этого значения — UPDATE в БД пропускаем. */
const TOUCH_DB_THRESHOLD_SECONDS = 60 * 60; // 1 час
const REDIS_KEY = (token: string) => `session:${token}`;

export async function createSession(
  db: Db,
  data: Omit<SessionData, 'expiresAt'>,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; data: SessionData }> {
  const token = uuidv7().replace(/-/g, '');
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const sessionData: SessionData = { ...data, expiresAt };

  await getRedis().set(REDIS_KEY(token), JSON.stringify(sessionData), 'EX', SESSION_TTL_SECONDS);

  await withTenantTx(db, data.tenantId, async (tx) => {
    await tx.insert(sessions).values({
      tenantId: data.tenantId,
      userId: data.userId,
      sessionToken: token,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      expiresAt: new Date(expiresAt),
    });
  });

  return { token, data: sessionData };
}

export async function getSession(token: string): Promise<SessionData | null> {
  if (!token) return null;
  const raw = await getRedis().get(REDIS_KEY(token));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as SessionData;
    if (data.expiresAt < Date.now()) {
      await getRedis().del(REDIS_KEY(token));
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Rolling/sliding refresh — продлевает срок жизни сессии на полный SESSION_TTL_SECONDS.
 * Вызывается из tRPC-контекста при каждом авторизованном запросе.
 *
 * Эффекты:
 *   1) обновляет expiresAt в Redis-payload и его TTL (главный источник правды);
 *   2) обновляет sessions.expires_at в БД, но не чаще раза в час, чтобы не превращать
 *      каждый запрос в write — DDL для аудита остаётся точным до часа.
 *
 * Если в Redis сессии уже нет (истекла) — функция ничего не делает.
 */
export async function touchSession(db: Db, token: string): Promise<void> {
  if (!token) return;
  const redis = getRedis();
  const raw = await redis.get(REDIS_KEY(token));
  if (!raw) return;
  let data: SessionData;
  try {
    data = JSON.parse(raw) as SessionData;
  } catch {
    return;
  }
  const now = Date.now();
  if (data.expiresAt < now) {
    await redis.del(REDIS_KEY(token));
    return;
  }
  const newExpiresAt = now + SESSION_TTL_SECONDS * 1000;
  const updated: SessionData = { ...data, expiresAt: newExpiresAt };
  await redis.set(REDIS_KEY(token), JSON.stringify(updated), 'EX', SESSION_TTL_SECONDS);

  const remainingSec = Math.max(0, Math.floor((data.expiresAt - now) / 1000));
  if (remainingSec < SESSION_TTL_SECONDS - TOUCH_DB_THRESHOLD_SECONDS) {
    // Прошло >=1 часа от прошлого touch — синхронизируем БД.
    await withTenantTx(db, data.tenantId, async (tx) => {
      await tx
        .update(sessions)
        .set({ expiresAt: new Date(newExpiresAt) })
        .where(eq(sessions.sessionToken, token));
    });
  }
}

export async function revokeSession(db: Db, tenantId: string, token: string): Promise<void> {
  await getRedis().del(REDIS_KEY(token));
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.sessionToken, token));
  });
}
