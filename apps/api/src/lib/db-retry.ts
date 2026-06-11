/**
 * Retry-обёртка для PostgreSQL serialization_failure (40001) и deadlock_detected (40P01).
 *
 * Эти ошибки — не баг приложения, а ожидаемое следствие конкурентных транзакций
 * с FOR UPDATE / SERIALIZABLE. PG ожидает, что приложение повторит транзакцию.
 *
 * Реализация: до 3 попыток с экспоненциальным backoff + jitter (~25 / 100 / 400 ms).
 * Любые иные ошибки пробрасываются сразу — мы только страхуем от concurrency.
 */
import { logger } from './logger';

export const RETRYABLE_PG_CODES: ReadonlySet<string> = new Set(['40001', '40P01']);

const BASE_DELAY_MS = 25;
const BACKOFF_FACTOR = 3;
const JITTER_LOW = 0.8;
const JITTER_HIGH = 1.2;

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && RETRYABLE_PG_CODES.has(code);
}

function backoffDelay(attempt: number): number {
  const base = BASE_DELAY_MS * BACKOFF_FACTOR ** (attempt - 1);
  const jitter = JITTER_LOW + Math.random() * (JITTER_HIGH - JITTER_LOW);
  return Math.round(base * jitter);
}

export async function withDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      lastErr = err;
      if (attempt >= maxAttempts) break;
      const delay = backoffDelay(attempt);
      logger.warn(
        { label, attempt, delay, code: (err as { code?: string }).code },
        'db-retry: retrying after PG concurrency error',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
