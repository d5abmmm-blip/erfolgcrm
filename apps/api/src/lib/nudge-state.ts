/**
 * Состояние нуджей инженерам — целиком в Redis (таблиц нет, потеря Redis = нуджи
 * просто начнут отсчёт заново, это приемлемо).
 *
 * Ключи:
 *   erfolg:eng-nudge:ask:{tenant}:{ticket}    — «по заявке недавно спрашивали» (дедуп, TTL 2 дня)
 *   erfolg:eng-nudge:count:{tenant}:{ticket}  — сколько нуджей БЕЗ ответа (для эскалации, TTL 14 дней)
 *   erfolg:eng-nudge:daily:{tenant}:{user}:{date} — счётчик нуджей инженеру за день (лимит 2)
 *   erfolg:eng-nudge:morning:{tenant}:{user}:{date} — утренний план уже отправлен
 *   erfolg:eng-nudge:visit:{tenant}:{ticket}:{date} — напоминание о выезде уже отправлено
 */
import { getRedis } from './redis';

export const NUDGE_ASK_TTL_SEC = 2 * 24 * 3600; // повторный вопрос по заявке — не чаще раза в 2 дня
export const NUDGE_COUNT_TTL_SEC = 14 * 24 * 3600;
export const NUDGE_DAILY_LIMIT = 2; // максимум вопросов «что с заявкой?» инженеру в день
const DAILY_TTL_SEC = 36 * 3600;
const SENT_FLAG_TTL_SEC = 36 * 3600;

const ask = (t: string, ticket: string) => `erfolg:eng-nudge:ask:${t}:${ticket}`;
const cnt = (t: string, ticket: string) => `erfolg:eng-nudge:count:${t}:${ticket}`;
const daily = (t: string, u: string, d: string) => `erfolg:eng-nudge:daily:${t}:${u}:${d}`;
const morning = (t: string, u: string, d: string) => `erfolg:eng-nudge:morning:${t}:${u}:${d}`;
const visit = (t: string, ticket: string, d: string) =>
  `erfolg:eng-nudge:visit:${t}:${ticket}:${d}`;

/** true — по заявке давно не спрашивали, слот занят нами (SET NX). */
export async function tryAcquireAskSlot(tenantId: string, ticketId: string): Promise<boolean> {
  const set = await getRedis().set(ask(tenantId, ticketId), '1', 'EX', NUDGE_ASK_TTL_SEC, 'NX');
  return set !== null;
}

/** Инженер ответил «ещё в работе» — молчим по заявке ещё столько же. */
export async function snoozeAsk(tenantId: string, ticketId: string): Promise<void> {
  await getRedis().set(ask(tenantId, ticketId), '1', 'EX', NUDGE_ASK_TTL_SEC);
}

/**
 * По каким из этих заявок мы сейчас молчим.
 *
 * ЗАЧЕМ ЭТО ЧИТАЕТ ЭКРАН, А НЕ ТОЛЬКО ВОРКЕР. Инженер жмёт «Ещё в работе»,
 * ему отвечают «пару дней не беспокою» — и бот правда замолкает. А блок
 * «Провисло» в мобильном списке считался без этой отметки и возвращался при
 * КАЖДОМ входе в приложение (жалоба с боя 2026-08-08, фото телефона). Обещание
 * и поведение разошлись; теперь у них один источник правды.
 *
 * Redis лёг — возвращаем пусто: лучше лишний раз спросить, чем спрятать
 * заявку, о которой никто не знает, что с ней.
 */
export async function askSnoozedTicketIds(
  tenantId: string,
  ticketIds: readonly string[],
): Promise<Set<string>> {
  if (ticketIds.length === 0) return new Set();
  try {
    const values = await getRedis().mget(ticketIds.map((id) => ask(tenantId, id)));
    const snoozed = new Set<string>();
    values.forEach((v, i) => {
      const id = ticketIds[i];
      if (v !== null && id) snoozed.add(id);
    });
    return snoozed;
  } catch {
    return new Set();
  }
}

export async function incrUnansweredCount(tenantId: string, ticketId: string): Promise<number> {
  const redis = getRedis();
  const key = cnt(tenantId, ticketId);
  const value = await redis.incr(key);
  await redis.expire(key, NUDGE_COUNT_TTL_SEC);
  return value;
}

export async function getUnansweredCount(tenantId: string, ticketId: string): Promise<number> {
  const raw = await getRedis().get(cnt(tenantId, ticketId));
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Любая реакция инженера по заявке — счётчик неответов обнуляется. */
export async function clearUnansweredCount(tenantId: string, ticketId: string): Promise<void> {
  await getRedis().del(cnt(tenantId, ticketId));
}

/** Сколько нуджей инженеру уже отправлено сегодня. */
export async function getDailyCount(
  tenantId: string,
  userId: string,
  dateStr: string,
): Promise<number> {
  const raw = await getRedis().get(daily(tenantId, userId, dateStr));
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Занять слот дневного лимита. true — лимит не исчерпан, нудж можно слать. */
export async function tryAcquireDailySlot(
  tenantId: string,
  userId: string,
  dateStr: string,
  limit = NUDGE_DAILY_LIMIT,
): Promise<boolean> {
  const redis = getRedis();
  const key = daily(tenantId, userId, dateStr);
  const value = await redis.incr(key);
  await redis.expire(key, DAILY_TTL_SEC);
  if (value > limit) return false;
  return true;
}

export async function tryMarkMorningSent(
  tenantId: string,
  userId: string,
  dateStr: string,
): Promise<boolean> {
  const set = await getRedis().set(
    morning(tenantId, userId, dateStr),
    '1',
    'EX',
    SENT_FLAG_TTL_SEC,
    'NX',
  );
  return set !== null;
}

export async function tryMarkVisitReminderSent(
  tenantId: string,
  ticketId: string,
  dateStr: string,
): Promise<boolean> {
  const set = await getRedis().set(
    visit(tenantId, ticketId, dateStr),
    '1',
    'EX',
    SENT_FLAG_TTL_SEC,
    'NX',
  );
  return set !== null;
}
