/**
 * Unit-тесты для withDbRetry — обёртка повторяет операцию при serialization_failure
 * (40001) и deadlock_detected (40P01) до 3 раз с экспоненциальным backoff.
 */
import { describe, it, expect } from 'vitest';
import { withDbRetry } from '../lib/db-retry';

class PgError extends Error {
  constructor(public readonly code: string) {
    super(`PG ${code}`);
  }
}

describe('withDbRetry', () => {
  it('успех с первой попытки — возвращает результат, не ретраит', async () => {
    let calls = 0;
    const result = await withDbRetry('test', async () => {
      calls++;
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it('40001 на первой попытке → повтор → успех', async () => {
    let calls = 0;
    const result = await withDbRetry('test', async () => {
      calls++;
      if (calls === 1) throw new PgError('40001');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('40P01 (deadlock) на первой попытке → повтор → успех', async () => {
    let calls = 0;
    const result = await withDbRetry('test', async () => {
      calls++;
      if (calls === 1) throw new PgError('40P01');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('после 3 неудачных попыток — пробрасывает последнюю ошибку', async () => {
    let calls = 0;
    await expect(
      withDbRetry('test', async () => {
        calls++;
        throw new PgError('40001');
      }),
    ).rejects.toBeInstanceOf(PgError);
    expect(calls).toBe(3);
  });

  it('не-retryable ошибка (например ValidationError) — НЕ ретраит', async () => {
    let calls = 0;
    class ValidationError extends Error {}
    await expect(
      withDbRetry('test', async () => {
        calls++;
        throw new ValidationError('bad input');
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toBe(1);
  });

  it('PG ошибка с НЕ-retryable code (например 23505 unique_violation) — НЕ ретраит', async () => {
    let calls = 0;
    await expect(
      withDbRetry('test', async () => {
        calls++;
        throw new PgError('23505');
      }),
    ).rejects.toBeInstanceOf(PgError);
    expect(calls).toBe(1);
  });
});
