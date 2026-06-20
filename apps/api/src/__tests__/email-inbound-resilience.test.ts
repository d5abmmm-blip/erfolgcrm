/**
 * Регрессия инцидента 2026-06-16: необработанное событие 'error' от ImapFlow роняло
 * ВЕСЬ процесс API (заявки/клиенты переставали работать из-за сбоя почты).
 *
 * ImapFlow — это EventEmitter, и в Node незанятое событие 'error' выбрасывается как
 * исключение и валит процесс (стандартная семантика EventEmitter). attachImapErrorGuard
 * вешает слушатель ДО connect(), гасит ошибку и логирует её. Здесь проверяем именно это.
 *
 * Воспроизводимая ошибка (mail.hosting.reg.ru, провал аутентификации/обрыв):
 *   Error: Connection not available  (code: 'NoConnection', authenticationFailed: true)
 *   Emitted 'error' event on ImapFlow instance ...
 *
 * Тест чисто юнит: не ходит в БД/Redis и не открывает реальных соединений.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachImapErrorGuard } from '../modules/email/imap';
import { logger } from '../lib/logger';

/** Форма ошибки, как её эмитит ImapFlow при провале аутентификации/обрыве соединения. */
function makeNoConnectionError(): Error {
  const err = new Error('Connection not available') as Error & {
    code?: string;
    authenticationFailed?: boolean;
  };
  err.code = 'NoConnection';
  err.authenticationFailed = true;
  return err;
}

describe('IMAP error resilience (attachImapErrorGuard)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('БЕЗ охранника событие error выбрасывается и уронило бы процесс (документируем баг)', () => {
    const bare = new EventEmitter();
    expect(() => bare.emit('error', makeNoConnectionError())).toThrow('Connection not available');
  });

  it('вешает ровно один слушатель события error', () => {
    const client = new EventEmitter();
    attachImapErrorGuard(client, 'tenant-1');
    expect(client.listenerCount('error')).toBe(1);
  });

  it('после охранника событие error НЕ роняет процесс', () => {
    const client = new EventEmitter();
    attachImapErrorGuard(client, 'tenant-1');
    expect(() => client.emit('error', makeNoConnectionError())).not.toThrow();
  });

  it('охранник логирует ошибку через logger.warn (не глотает её молча)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const client = new EventEmitter();
    const err = makeNoConnectionError();

    attachImapErrorGuard(client, 'tenant-42');
    client.emit('error', err);

    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toMatchObject({ err, tenantId: 'tenant-42' });
    expect(message).toContain('подавлено событие error');
  });
});
