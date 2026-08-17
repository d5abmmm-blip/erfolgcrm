/**
 * «Сегодня» организации — ОДНО определение на всю систему.
 *
 * До этого «сегодня» считалось тремя способами, и они расходились:
 *   1. `CURRENT_DATE` в SQL — день в таймзоне СЕССИИ базы (на бою это UTC):
 *      для Москвы новый день наступал в 03:00, и просрочка счетов и ТО, статус
 *      гарантий, «сегодня» на дашборде и в кассе переключались на три часа позже.
 *   2. `new Date().toISOString().slice(0, 10)` в TS — тоже UTC, та же ошибка
 *      (дата выставления счёта, дата продажи trade-in, статус аттестаций).
 *   3. Пять одинаковых локальных копий «дня в таймзоне тенанта» (attendance,
 *      staff, ai-assistant, engineer-profile ×2) — эти считали правильно.
 *
 * ПРАВИЛО: «сегодня» — календарный день в таймзоне организации
 * (`tenants.timezone`, NOT NULL, по умолчанию Europe/Moscow).
 *
 * В SQL таймзона берётся скалярным подзапросом из строки тенанта, поэтому
 * сигнатуры запросов не меняются — tenantId в репозиториях и так есть везде;
 * подзапрос по первичному ключу планировщик выполняет один раз (InitPlan).
 *
 * ⚠️ Для timestamptz-колонок (`next_due_at` у ТО) голый `::date` ТОЖЕ зависит
 * от таймзоны сессии — момент сначала переводится в день организации
 * (orgDaySql), и только он сравнивается с «сегодня».
 */
import { sql, type SQL } from 'drizzle-orm';

/** Минимум, который нужен от Db/Tx: выполнить запрос. Подходят оба. */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

/** Календарный день момента в заданной таймзоне, YYYY-MM-DD. */
export function dayInTimezone(timezone: string, instant: Date): string {
  try {
    // en-CA даёт ровно YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    // Нечитаемая таймзона в строке тенанта — ведём себя как раньше (UTC).
    return instant.toISOString().slice(0, 10);
  }
}

/** Сегодня в таймзоне организации, YYYY-MM-DD. */
export function todayInTimezone(timezone: string, now: Date = new Date()): string {
  return dayInTimezone(timezone, now);
}

/** Таймзона тенанта — скалярный подзапрос по PK. */
function tenantTimezoneSql(tenantId: string): SQL {
  return sql`(SELECT timezone FROM tenants WHERE id = ${tenantId})`;
}

/** SQL-зеркало: «сегодня» организации как date. */
export function orgTodaySql(tenantId: string): SQL {
  return sql`(now() AT TIME ZONE ${tenantTimezoneSql(tenantId)})::date`;
}

/** SQL-зеркало: календарный день МОМЕНТА (timestamptz) в таймзоне организации. */
export function orgDaySql(tenantId: string, instant: SQL): SQL {
  return sql`(${instant} AT TIME ZONE ${tenantTimezoneSql(tenantId)})::date`;
}

/** «Сегодня» организации значением YYYY-MM-DD — когда день нужен строкой (date-колонки, сравнение в TS). */
export async function orgTodayValue(ex: SqlExecutor, tenantId: string): Promise<string> {
  const rows = (await ex.execute(sql`SELECT (${orgTodaySql(tenantId)})::text AS d`)) as Array<{
    d: string | null;
  }>;
  const d = rows[0]?.d;
  if (!d) throw new Error(`orgTodayValue: тенант ${tenantId} не найден`);
  return d;
}

/** День момента в таймзоне организации значением YYYY-MM-DD. */
export async function orgDayValue(
  ex: SqlExecutor,
  tenantId: string,
  instant: Date,
): Promise<string> {
  // Date в параметр сырого фрагмента передавать нельзя (drizzle шлёт его как
  // toString(), Postgres не парсит) — поэтому ISO-строка с явным ::timestamptz.
  const rows = (await ex.execute(
    sql`SELECT (${orgDaySql(tenantId, sql`${instant.toISOString()}::timestamptz`)})::text AS d`,
  )) as Array<{ d: string | null }>;
  const d = rows[0]?.d;
  if (!d) throw new Error(`orgDayValue: тенант ${tenantId} не найден`);
  return d;
}
