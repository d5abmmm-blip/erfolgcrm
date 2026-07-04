/**
 * Привязка сотрудника к Telegram-чату tenant-бота (нуджи инженерам, Фаза «AI тыкает сам»).
 *
 * Поток: staff/инженер просит код (tRPC) → СРМ отдаёт deep-link
 * t.me/<bot>?start=link_<code> → сотрудник жмёт Start → вебхук видит
 * «/start link_<code>», находит код в Redis и пишет chat_id в users.telegram_chat_id.
 *
 * Код одноразовый, TTL 15 минут, живёт только в Redis (таблица не нужна).
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { users, withTenantTx, type Db } from '@erfolg/db';
import { getRedis } from '../../lib/redis';

export const LINK_CODE_TTL_SEC = 15 * 60;
export const LINK_PAYLOAD_PREFIX = 'link_';

function codeKey(code: string): string {
  return `erfolg:tg-link:${code}`;
}

export interface LinkCodePayload {
  tenantId: string;
  userId: string;
}

/** Сгенерировать одноразовый код привязки для пользователя. */
export async function createLinkCode(tenantId: string, userId: string): Promise<string> {
  const code = randomBytes(8).toString('hex');
  await getRedis().set(
    codeKey(code),
    JSON.stringify({ tenantId, userId } satisfies LinkCodePayload),
    'EX',
    LINK_CODE_TTL_SEC,
  );
  return code;
}

/** Забрать и погасить код (одноразовость через GETDEL). */
export async function consumeLinkCode(code: string): Promise<LinkCodePayload | null> {
  if (!/^[0-9a-f]{16}$/.test(code)) return null;
  const raw = await getRedis().getdel(codeKey(code));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LinkCodePayload;
  } catch {
    return null;
  }
}

export interface LinkedStaffUser {
  id: string;
  username: string;
  fullName: string;
  role: 'director' | 'dispatcher' | 'engineer';
  isActive: boolean;
}

/** Найти активного сотрудника по chat_id (для callback-кнопок и «/start link_»). */
export async function findUserByChatId(
  db: Db,
  tenantId: string,
  chatId: number,
): Promise<LinkedStaffUser | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        role: users.role,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.telegramChatId, BigInt(chatId)))
      .limit(1);
    const r = rows[0];
    return r && r.isActive ? r : null;
  });
}

/**
 * Привязать чат к пользователю. Если этот chat_id уже висел на другом сотруднике
 * tenant'а — перевешиваем (один телефон = один сотрудник, частичный UNIQUE-индекс).
 */
export async function linkChatToUser(
  db: Db,
  tenantId: string,
  userId: string,
  chatId: number,
): Promise<{ fullName: string } | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(users)
      .set({ telegramChatId: null, updatedAt: sql`now()` })
      .where(eq(users.telegramChatId, BigInt(chatId)));
    const rows = await tx
      .update(users)
      .set({ telegramChatId: BigInt(chatId), updatedAt: sql`now()` })
      .where(eq(users.id, userId))
      .returning({ fullName: users.fullName });
    return rows[0] ?? null;
  });
}

/** Отвязать Telegram от пользователя. */
export async function unlinkChat(db: Db, tenantId: string, userId: string): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(users)
      .set({ telegramChatId: null, updatedAt: sql`now()` })
      .where(eq(users.id, userId));
  });
}

/** Есть ли привязка у пользователя. */
export async function isChatLinked(db: Db, tenantId: string, userId: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ chatId: users.telegramChatId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.chatId != null;
  });
}

/**
 * chat_id пользователя (для исходящих нуджей). null — не привязан ИЛИ сотрудник
 * заблокирован (уволенным нуджи с внутренними данными не шлём).
 */
export async function getChatIdForUser(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<number | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ chatId: users.telegramChatId, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const r = rows[0];
    if (!r || !r.isActive) return null;
    return r.chatId == null ? null : Number(r.chatId);
  });
}
