/**
 * Тесты offline-очереди.
 *
 * Покрытие:
 *   - enqueue + listPending + count + remove
 *   - executeOrQueue: ok / queued (network error) / error (TRPC business)
 *   - syncOutbox: успех → удалить; soft-fail → attempts++; hard-fail → удалить.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import {
  clearAll,
  count,
  enqueue,
  listPending,
  remove,
  removeByDedupeKey,
} from '../lib/offline/queue';
import { executeOrQueue, syncOutbox } from '../lib/offline/executor';
import type { AppRouter } from '@erfolg/api';

beforeEach(async () => {
  await clearAll();
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    value: true,
  });
});

describe('outbox queue', () => {
  it('enqueue + listPending preserve insertion order', async () => {
    await enqueue('tickets.changeStatus', { id: '1', status: 'diagnostics' }, 'erfolg');
    await new Promise((r) => setTimeout(r, 5));
    await enqueue('tickets.addNote', { ticketId: '1', comment: 'hi' }, 'erfolg');

    const items = await listPending();
    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe('tickets.changeStatus');
    expect(items[1]!.kind).toBe('tickets.addNote');
    expect(await count()).toBe(2);
  });

  // Строка наряда сохраняется по уходу курсора из КАЖДОГО поля. Без склейки
  // одна новая строка легла бы в очередь трижды — и сервер вставил бы три строки.
  it('dedupeKey: повторная правка ЗАМЕНЯЕТ запись, а не добавляет вторую', async () => {
    const key = 'wo-line:T1:draft-1';
    await enqueue('workOrders.upsertLine', { line: { name: 'Замена платы' } }, 'erfolg', key);
    await enqueue(
      'workOrders.upsertLine',
      { line: { name: 'Замена платы', quantity: '2' } },
      'erfolg',
      key,
    );
    await enqueue(
      'workOrders.upsertLine',
      { line: { name: 'Замена платы', quantity: '2', unitPriceRub: 18000 } },
      'erfolg',
      key,
    );

    const items = await listPending();
    expect(items).toHaveLength(1);
    expect(items[0]!.payload).toEqual({
      line: { name: 'Замена платы', quantity: '2', unitPriceRub: 18000 },
    });
  });

  it('dedupeKey: разные строки друг друга не вытесняют', async () => {
    await enqueue('workOrders.upsertLine', { n: 1 }, 'erfolg', 'wo-line:T1:a');
    await enqueue('workOrders.upsertLine', { n: 2 }, 'erfolg', 'wo-line:T1:b');
    expect(await count()).toBe(2);
  });

  it('dedupeKey: склейка сохраняет исходное место в очереди', async () => {
    await enqueue('workOrders.upsertLine', { n: 'первая' }, 'erfolg', 'wo-line:T1:a');
    await new Promise((r) => setTimeout(r, 5));
    await enqueue('tickets.addNote', { comment: 'вторая' }, 'erfolg');
    await new Promise((r) => setTimeout(r, 5));
    // правим первую строку — она должна остаться ПЕРВОЙ, а не уехать в конец
    await enqueue('workOrders.upsertLine', { n: 'первая, правка' }, 'erfolg', 'wo-line:T1:a');

    const items = await listPending();
    expect(items).toHaveLength(2);
    expect(items[0]!.payload).toEqual({ n: 'первая, правка' });
    expect(items[1]!.kind).toBe('tickets.addNote');
  });

  it('removeByDedupeKey убирает отменённую строку из очереди', async () => {
    await enqueue('workOrders.upsertLine', { n: 1 }, 'erfolg', 'wo-line:T1:a');
    await enqueue('workOrders.upsertLine', { n: 2 }, 'erfolg', 'wo-line:T1:b');
    expect(await removeByDedupeKey('wo-line:T1:a')).toBe(1);
    const left = await listPending();
    expect(left).toHaveLength(1);
    expect(left[0]!.dedupeKey).toBe('wo-line:T1:b');
  });

  it('без dedupeKey поведение прежнее — записи копятся', async () => {
    await enqueue('tickets.addNote', { comment: 'a' }, 'erfolg');
    await enqueue('tickets.addNote', { comment: 'b' }, 'erfolg');
    expect(await count()).toBe(2);
  });

  it('remove deletes by id', async () => {
    const a = await enqueue('tickets.changeStatus', { id: '1' }, null);
    await enqueue('tickets.addNote', { ticketId: '2', comment: 'x' }, null);
    await remove(a.id);
    const left = await listPending();
    expect(left).toHaveLength(1);
    expect(left[0]!.kind).toBe('tickets.addNote');
  });
});

describe('executeOrQueue', () => {
  it('returns {status: ok} on success', async () => {
    const res = await executeOrQueue(
      'tickets.changeStatus',
      { id: '42' },
      async () => ({ id: '42', from: 'received', to: 'diagnostics' }),
      'erfolg',
    );
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.data).toEqual({ id: '42', from: 'received', to: 'diagnostics' });
    }
    expect(await count()).toBe(0);
  });

  it('queues on TypeError (fetch failed)', async () => {
    const res = await executeOrQueue(
      'tickets.changeStatus',
      { id: '42' },
      async () => {
        throw new TypeError('Failed to fetch');
      },
      'erfolg',
    );
    expect(res.status).toBe('queued');
    expect(await count()).toBe(1);
  });

  it('queues when navigator.onLine === false even on Error', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    const res = await executeOrQueue(
      'tickets.addNote',
      { ticketId: '1', comment: 'hi' },
      async () => {
        throw new Error('whatever');
      },
      'erfolg',
    );
    expect(res.status).toBe('queued');
    expect(await count()).toBe(1);
  });

  it('returns {status: error} on TRPC business error (BAD_REQUEST)', async () => {
    const trpcErr = new TRPCClientError<AppRouter>('Bad input', {
      result: {
        error: {
          code: -32600,
          message: 'BAD_REQUEST',
          data: { code: 'BAD_REQUEST', httpStatus: 400, path: 'tickets.create' },
        },
      },
    } as never);
    const res = await executeOrQueue(
      'tickets.changeStatus',
      { id: '42' },
      async () => {
        throw trpcErr;
      },
      'erfolg',
    );
    expect(res.status).toBe('error');
    expect(await count()).toBe(0);
  });
});

describe('syncOutbox', () => {
  it('removes item on successful runner', async () => {
    await enqueue('tickets.addNote', { ticketId: '1', comment: 'hi' }, 'erfolg');
    const runner = vi.fn().mockResolvedValue({ id: 'note-1' });
    const r = await syncOutbox(runner);
    expect(r).toEqual({ succeeded: 1, failedSoft: 0, failedHard: 0 });
    expect(await count()).toBe(0);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('keeps item and bumps attempts on network error', async () => {
    await enqueue('tickets.addNote', { ticketId: '1', comment: 'hi' }, 'erfolg');
    const runner = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const r = await syncOutbox(runner);
    expect(r).toEqual({ succeeded: 0, failedSoft: 1, failedHard: 0 });
    const items = await listPending();
    expect(items).toHaveLength(1);
    expect(items[0]!.attempts).toBe(1);
    expect(items[0]!.lastError).toContain('Failed to fetch');
  });

  it('removes item on hard (business) error', async () => {
    await enqueue('tickets.addNote', { ticketId: '1', comment: 'hi' }, 'erfolg');
    const trpcErr = new TRPCClientError<AppRouter>('Forbidden', {
      result: {
        error: {
          code: -32600,
          message: 'FORBIDDEN',
          data: { code: 'FORBIDDEN', httpStatus: 403, path: 'tickets.addNote' },
        },
      },
    } as never);
    const runner = vi.fn().mockRejectedValue(trpcErr);
    const r = await syncOutbox(runner);
    expect(r).toEqual({ succeeded: 0, failedSoft: 0, failedHard: 1 });
    expect(await count()).toBe(0);
  });

  // Этап 5: NOT_ENOUGH_STOCK при синке inventoryMovements.issueToWorkOrder —
  // это бизнес-ошибка (UNPROCESSABLE_CONTENT), не сетевая. Должна попасть в failedHard.
  it('Stage 5: inventoryMovements.issueToWorkOrder с NOT_ENOUGH_STOCK → failedHard', async () => {
    await enqueue(
      'inventoryMovements.issueToWorkOrder',
      { workOrderLineId: 'L', itemId: 'I', quantity: '100' },
      'erfolg',
    );
    const trpcErr = new TRPCClientError<AppRouter>('NOT_ENOUGH_STOCK', {
      result: {
        error: {
          code: -32600,
          message: 'NOT_ENOUGH_STOCK',
          data: {
            code: 'UNPROCESSABLE_CONTENT',
            httpStatus: 422,
            path: 'inventoryMovements.issueToWorkOrder',
          },
        },
      },
    } as never);
    const runner = vi.fn().mockRejectedValue(trpcErr);
    const r = await syncOutbox(runner);
    expect(r).toEqual({ succeeded: 0, failedSoft: 0, failedHard: 1 });
    expect(await count()).toBe(0);
  });

  it('Stage 5: maintenance.recordPerformed успешно проходит через runner', async () => {
    await enqueue(
      'maintenance.recordPerformed',
      {
        assetId: 'A',
        scheduleId: 'S',
        summary: 'Замена фильтра',
      },
      'erfolg',
    );
    const runner = vi.fn().mockResolvedValue({ id: 'log-1' });
    const r = await syncOutbox(runner);
    expect(r).toEqual({ succeeded: 1, failedSoft: 0, failedHard: 0 });
    expect(await count()).toBe(0);
  });

  it('processes mixed batch correctly', async () => {
    await enqueue('tickets.addNote', { ticketId: '1', comment: 'a' }, 'erfolg');
    await enqueue('tickets.addNote', { ticketId: '2', comment: 'b' }, 'erfolg');
    await enqueue('tickets.addNote', { ticketId: '3', comment: 'c' }, 'erfolg');
    let i = 0;
    const runner = vi.fn().mockImplementation(async () => {
      i++;
      if (i === 1) return { id: 'ok' };
      if (i === 2) throw new TypeError('Failed to fetch');
      const e = new TRPCClientError<AppRouter>('not found', {
        result: {
          error: {
            code: -32600,
            message: 'NOT_FOUND',
            data: { code: 'NOT_FOUND', httpStatus: 404, path: 'tickets.addNote' },
          },
        },
      } as never);
      throw e;
    });
    const r = await syncOutbox(runner);
    expect(r).toEqual({ succeeded: 1, failedSoft: 1, failedHard: 1 });
    expect(await count()).toBe(1);
  });
});
