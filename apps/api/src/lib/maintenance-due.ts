/**
 * «Просрочено» и «на сегодня» у планового ТО — одно определение на всю систему.
 *
 * БЫЛО ЧЕТЫРЕ РАЗНЫХ. Раздел ТО считал по метке времени (`next_due_at <= now()`),
 * дашборд в двух местах давал сутки форы (`next_due_at < now() - interval '1 day'`),
 * а список «ТО на сегодня» сравнивал по дате (`next_due_at::date < CURRENT_DATE`).
 * График, у которого срок наступил сегодня утром, был просрочен на одном экране и
 * не просрочен на другом: директор видел два разных числа и не знал, какому верить.
 *
 * ПРАВИЛО: просрочено, если плановый ДЕНЬ уже прошёл. Пока день идёт — ТО можно
 * успеть сделать, и красным оно не считается.
 *
 * «Сегодня» — день в таймзоне ОРГАНИЗАЦИИ (lib/org-day.ts), а не базы данных:
 * раньше `CURRENT_DATE` жил по UTC и новый день для Москвы наступал в 03:00.
 * `next_due_at` — timestamptz, поэтому и его календарный день берётся через
 * orgDaySql: голый `::date` зависел бы от таймзоны сессии.
 */
import { sql, type SQL } from 'drizzle-orm';
import { orgDaySql, orgTodaySql } from './org-day';

/** Просрочено: плановый день уже прошёл. */
export function maintenanceOverdueSql(nextDueAt: SQL, tenantId: string): SQL {
  return sql`${orgDaySql(tenantId, nextDueAt)} < ${orgTodaySql(tenantId)}`;
}

/** Срок наступает сегодня. */
export function maintenanceDueTodaySql(nextDueAt: SQL, tenantId: string): SQL {
  return sql`${orgDaySql(tenantId, nextDueAt)} = ${orgTodaySql(tenantId)}`;
}

/** Просрочено ИЛИ на сегодня — то, чем занимаются прямо сейчас. */
export function maintenanceDueByTodaySql(nextDueAt: SQL, tenantId: string): SQL {
  return sql`${orgDaySql(tenantId, nextDueAt)} <= ${orgTodaySql(tenantId)}`;
}
