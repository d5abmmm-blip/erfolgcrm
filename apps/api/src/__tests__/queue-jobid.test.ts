/**
 * Регресс-гард BullMQ-гочи: custom jobId продюсеров НЕ должен содержать ':'.
 *
 * BullMQ молча отвергает job, чей jobId содержит ':', — именно из-за этого письма
 * о смене статуса заявки не ставились в очередь и не отправлялись клиенту (фикс
 * 2026-06-16). Воркер-тесты вызывают processor напрямую, минуя очередь, поэтому
 * эту ветку (продюсер → add) они не покрывают. Здесь мокаем getQueue и проверяем
 * сам jobId, который продюсер передаёт в .add().
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const calls: Array<Record<string, unknown>> = [];
  const addSpy = vi.fn(
    async (_name: string, _data: unknown, opts: Record<string, unknown>) => {
      calls.push(opts);
      return { id: 'mock' };
    },
  );
  return { calls, addSpy };
});

vi.mock('../lib/queue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getQueue: () => ({ add: hoisted.addSpy }),
  };
});

import { enqueueTicketStatusNotify } from '../workers/ticket-status-notify';
import { enqueueAttachmentPurge } from '../workers/storage-cleanup';

beforeEach(() => {
  hoisted.calls.length = 0;
  hoisted.addSpy.mockClear();
});

describe('jobId продюсеров не содержит ":" (иначе BullMQ молча теряет job)', () => {
  it('enqueueTicketStatusNotify', async () => {
    await enqueueTicketStatusNotify({
      tenantId: '11111111-1111-1111-1111-111111111111',
      ticketId: '22222222-2222-2222-2222-222222222222',
      oldStatus: 'in_progress',
      newStatus: 'act_pending',
    });
    expect(hoisted.addSpy).toHaveBeenCalledTimes(1);
    const jobId = hoisted.calls[0]?.jobId;
    if (typeof jobId !== 'string') throw new Error('jobId должен быть строкой');
    expect(jobId).not.toContain(':');
    expect(jobId.startsWith('notify-')).toBe(true);
  });

  it('enqueueAttachmentPurge', async () => {
    await enqueueAttachmentPurge({
      tenantId: '11111111-1111-1111-1111-111111111111',
      attachmentId: '33333333-3333-3333-3333-333333333333',
      objectKey: 'tenants/x/att/y.pdf',
    });
    expect(hoisted.addSpy).toHaveBeenCalledTimes(1);
    const jobId = hoisted.calls[0]?.jobId;
    if (typeof jobId !== 'string') throw new Error('jobId должен быть строкой');
    expect(jobId).not.toContain(':');
    expect(jobId.startsWith('purge-')).toBe(true);
  });
});
