/**
 * Тексты ошибок для человека.
 *
 * Главное, что проверяем: наружу НЕ должны просачиваться SQL, JSON от Zod и
 * машинные коды — сервер кладёт текст исходной ошибки прямо в
 * INTERNAL_SERVER_ERROR (`apps/api/src/lib/errors.ts`).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import { humanizeError, isOfflineError } from '../lib/error-message';
import type { AppRouter } from '@erfolg/api';

function trpcError(message: string, code: string, httpStatus = 500) {
  return new TRPCClientError<AppRouter>(message, {
    result: {
      error: { code: -32600, message, data: { code, httpStatus, path: 'workOrders.upsertLine' } },
    },
  } as never);
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
});

describe('isOfflineError', () => {
  it('TypeError (fetch failed) — сетевая', () => {
    expect(isOfflineError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('navigator.onLine === false — сетевая при любой ошибке', () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
    expect(isOfflineError(new Error('что угодно'))).toBe(true);
  });

  it('ответ сервера с кодом — НЕ сетевая', () => {
    expect(isOfflineError(trpcError('Bad input', 'BAD_REQUEST', 400))).toBe(false);
  });
});

describe('humanizeError', () => {
  it('нет связи → говорит, что изменение не сохранено', () => {
    expect(humanizeError(new TypeError('Failed to fetch'))).toBe(
      'Нет связи с сервером. Изменение не сохранено',
    );
  });

  it('истёкшая сессия → зовёт войти заново', () => {
    expect(humanizeError(trpcError('UNAUTHORIZED', 'UNAUTHORIZED', 401))).toContain(
      'Сессия истекла',
    );
  });

  it('SQL из INTERNAL_SERVER_ERROR наружу не выходит', () => {
    const msg = humanizeError(
      trpcError(
        'insert into "work_order_lines" ("id","name") values ($1,$2) - duplicate key value violates unique constraint',
        'INTERNAL_SERVER_ERROR',
      ),
    );
    expect(msg).toBe('Ошибка на сервере. Изменение не сохранено, попробуйте ещё раз');
    expect(msg).not.toMatch(/insert|constraint|work_order_lines/i);
  });

  it('JSON от Zod наружу не выходит', () => {
    const zod = '[\n  {\n    "code": "too_small",\n    "path": ["line","quantity"]\n  }\n]';
    const msg = humanizeError(trpcError(zod, 'BAD_REQUEST', 400));
    expect(msg).toBe('Проверьте заполнение полей — сервер не принял данные');
    expect(msg).not.toContain('{');
  });

  it('машинный код склада переводится на русский', () => {
    expect(humanizeError(trpcError('NOT_ENOUGH_STOCK', 'UNPROCESSABLE_CONTENT', 422))).toBe(
      'Недостаточно остатков на складе',
    );
  });

  it('осмысленное доменное сообщение сохраняется как есть', () => {
    expect(humanizeError(trpcError('Нельзя удалить заявку с оплатами', 'BAD_REQUEST', 400))).toBe(
      'Нельзя удалить заявку с оплатами',
    );
  });

  it('незнакомая ошибка не оставляет пользователя без объяснения', () => {
    expect(humanizeError(undefined)).toBe('Не удалось сохранить изменение');
    expect(humanizeError(new Error(''))).toBe('Не удалось сохранить изменение');
  });
});
