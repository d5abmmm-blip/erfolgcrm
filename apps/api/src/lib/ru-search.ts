import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Регистронезависимый поиск по подстроке, работающий с кириллицей.
 *
 * База создана с локалью «C» (POSTGRES_INITDB_ARGS в docker-compose), и в ней
 * обычный ILIKE / lower() не сворачивает регистр русских букв: «Улыбка» не
 * находится по запросу «улыбка». Лечится явной ICU-collation на стороне колонки
 * (тот же приём, что в kb-articles/repository.ts), а паттерн приводим к нижнему
 * регистру в JS — String.prototype.toLowerCase() Unicode-aware.
 *
 * Замена drizzle-овскому ilike() во всех пользовательских поисках, где могут
 * встречаться русские буквы. Для чисто технических полей (UUID, IP, номера)
 * ilike() оставлен как есть.
 */
export function ruIlike(column: SQLWrapper, pattern: string): SQL {
  return sql`lower(${column} COLLATE "ru-x-icu") LIKE ${pattern.toLowerCase()}`;
}
