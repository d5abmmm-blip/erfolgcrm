/**
 * Извлечение кода/текста ошибки PostgreSQL из цепочки .cause.
 *
 * drizzle-orm ≥0.44 оборачивает ошибки драйвера в DrizzleQueryError
 * («Failed query: …»), а оригинальная ошибка postgres-js с .code
 * (23505 unique_violation, 23514 check_violation, 40001/40P01 concurrency)
 * лежит в .cause. После обновления drizzle прямые проверки err.code молча
 * перестали срабатывать — поэтому ВСЕ проверки кодов PG идут через эти
 * helpers (работают и со старой «голой» формой, и с обёрнутой).
 */

export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  // Ограничение глубины — защита от циклической цепочки cause.
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Склеенный текст всей цепочки ошибок — для матчей по имени constraint'а/индекса. */
export function pgErrorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (cur instanceof Error) parts.push(cur.message);
    else if (typeof cur === 'string') parts.push(cur);
    else parts.push(JSON.stringify(cur));
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return parts.join(' <- ');
}
