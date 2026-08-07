/**
 * Очередь правок не теряет работу инженера.
 *
 * ЧТО БЫЛО. При любом отказе сервера запись УДАЛЯЛАСЬ из очереди насовсем,
 * а человек видел только число: «сервер не принял 3 изменения». Что именно
 * не приняли и какой текст комментария он писал — восстановить нельзя.
 *
 * Худший случай: инженер работал офлайн всю смену, за это время его сессия
 * протухла. Связь вернулась — сервер на КАЖДУЮ накопленную правку ответил
 * «вы не авторизованы». Для очереди это был обычный отказ по существу,
 * и вся работа за смену стиралась молча.
 *
 * И отдельно: записи не были привязаны к автору. Инженер А вышел, на том же
 * телефоне вошёл Б — правки А уходили на сервер от имени Б, вместе с его
 * строками наряда, от которых считается зарплата.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@erfolg/api';
import { clearAll, count, enqueue, listPending, retryOutboxItem } from '../lib/offline/queue';
import { syncOutbox } from '../lib/offline/executor';
import { describeOutboxItem } from '../lib/offline/describe-outbox';
import { getCurrentUserId, setCurrentUserId } from '../lib/offline/current-user';

/** Ошибка от сервера с конкретным кодом tRPC. */
function trpcError(code: string, httpStatus: number, message = code) {
  return new TRPCClientError<AppRouter>(message, {
    result: {
      error: { code: -32600, message, data: { code, httpStatus, path: 'tickets.addNote' } },
    },
  } as never);
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId(null);
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
});

afterEach(async () => {
  await clearAll();
  setCurrentUserId(null);
});

describe('отказ сервера не стирает работу', () => {
  it('запись остаётся с причиной, а не исчезает', async () => {
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'Заменил блок питания' }, 'erfolg');
    const runner = vi.fn().mockRejectedValue(trpcError('FORBIDDEN', 403, 'Нет доступа'));

    const r = await syncOutbox(runner);

    expect(r.failedHard).toBe(1);
    expect(await count()).toBe(1); // раньше здесь был 0 — работа пропадала
    const [item] = await listPending();
    expect(item!.failedHard).toBe(true);
    expect(item!.lastError).toContain('Нет доступа');
    // Текст комментария восстановим — он лежит рядом.
    expect(item!.payload).toMatchObject({ comment: 'Заменил блок питания' });
  });

  it('отклонённое не долбит сервер при каждом возврате связи', async () => {
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'x' }, 'erfolg');
    const runner = vi.fn().mockRejectedValue(trpcError('BAD_REQUEST', 400));

    await syncOutbox(runner);
    const second = await syncOutbox(runner);

    expect(runner).toHaveBeenCalledOnce();
    expect(second).toMatchObject({ succeeded: 0, failedSoft: 0, failedHard: 0 });
  });

  it('«повторить» снимает пометку и запись снова уходит', async () => {
    const item = await enqueue('tickets.addNote', { ticketId: 't1', comment: 'x' }, 'erfolg');
    await syncOutbox(vi.fn().mockRejectedValue(trpcError('BAD_REQUEST', 400)));

    await retryOutboxItem(item.id);
    const [reset] = await listPending();
    expect(reset!.failedHard).toBeFalsy();

    const r = await syncOutbox(vi.fn().mockResolvedValue({}));
    expect(r.succeeded).toBe(1);
    expect(await count()).toBe(0);
  });
});

describe('протухшая сессия — мягкая ошибка, а не потеря смены', () => {
  it('UNAUTHORIZED оставляет запись готовой к отправке и просит войти', async () => {
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'смена в подвале' }, 'erfolg');
    await enqueue('workOrders.upsertLine', { ticketId: 't1', line: { name: 'Плата' } }, 'erfolg');
    const runner = vi.fn().mockRejectedValue(trpcError('UNAUTHORIZED', 401, 'Требуется вход'));

    const r = await syncOutbox(runner);

    expect(r.needsLogin).toBe(true);
    expect(r.failedHard).toBe(0); // это НЕ отказ по существу
    expect(await count()).toBe(2);
    const items = await listPending();
    // Ничего не помечено «не принято» — после входа уйдёт само.
    expect(items.every((i) => !i.failedHard)).toBe(true);
  });

  it('после входа накопленное уходит', async () => {
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'смена' }, 'erfolg');
    await syncOutbox(vi.fn().mockRejectedValue(trpcError('UNAUTHORIZED', 401)));

    const r = await syncOutbox(vi.fn().mockResolvedValue({}));

    expect(r.succeeded).toBe(1);
    expect(await count()).toBe(0);
  });
});

describe('правки принадлежат автору', () => {
  it('запись инженера А не уходит от имени Б', async () => {
    setCurrentUserId('engineer-A');
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'это писал А' }, 'erfolg');
    expect((await listPending())[0]!.userId).toBe('engineer-A');

    // На том же телефоне вошёл другой инженер.
    setCurrentUserId('engineer-B');
    const runner = vi.fn().mockResolvedValue({});
    const r = await syncOutbox(runner);

    expect(runner).not.toHaveBeenCalled();
    expect(r.skippedOther).toBe(1);
    expect(await count()).toBe(1); // работа А на месте, ждёт его самого
  });

  it('вернулся А — его правки уходят', async () => {
    setCurrentUserId('engineer-A');
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'это писал А' }, 'erfolg');

    setCurrentUserId('engineer-B');
    await syncOutbox(vi.fn().mockResolvedValue({}));
    setCurrentUserId('engineer-A');
    const r = await syncOutbox(vi.fn().mockResolvedValue({}));

    expect(r.succeeded).toBe(1);
    expect(await count()).toBe(0);
  });

  it('записи, сделанные до этой правки, не застревают навсегда', async () => {
    // Старая запись без автора: отправляем как раньше, иначе после обновления
    // приложения накопленное осталось бы лежать мёртвым грузом.
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'старая' }, 'erfolg');
    setCurrentUserId('engineer-B');

    const r = await syncOutbox(vi.fn().mockResolvedValue({}));
    expect(r.succeeded).toBe(1);
  });

  it('текущий автор запоминается и читается', () => {
    setCurrentUserId('u-42');
    expect(getCurrentUserId()).toBe('u-42');
    setCurrentUserId(null);
    expect(getCurrentUserId()).toBeNull();
  });
});

describe('человеческое описание записи', () => {
  it('комментарий показывается текстом', () => {
    const d = describeOutboxItem({
      kind: 'tickets.addNote',
      payload: { ticketId: 't1', comment: 'Заменил блок питания' },
      label: 'WSP-6472',
    });
    expect(d.title).toContain('Комментарий');
    expect(d.title).toContain('WSP-6472');
    expect(d.detail).toBe('Заменил блок питания');
  });

  it('смена статуса называется по-русски', () => {
    const d = describeOutboxItem({
      kind: 'tickets.changeStatus',
      payload: { id: 't1', status: 'in_progress' },
    });
    expect(d.title).toContain('Статус');
    expect(d.detail).toBe('В работе');
  });

  it('строка наряда показывает что и сколько', () => {
    const d = describeOutboxItem({
      kind: 'workOrders.upsertLine',
      payload: {
        ticketId: 't1',
        line: { name: 'Замена платы', quantity: '2', unit: 'шт', unitPriceRub: 18000 },
      },
    });
    expect(d.title).toContain('наряд');
    expect(d.detail).toContain('Замена платы');
    expect(d.detail).toContain('2');
  });

  it('незнакомый вид не оставляет человека без подписи', () => {
    const d = describeOutboxItem({
      kind: 'maintenance.recordPerformed',
      payload: { summary: 'Замена фильтра' },
    });
    expect(d.title.length).toBeGreaterThan(0);
  });

  it('копируемый текст содержит и подпись, и содержимое', () => {
    const d = describeOutboxItem({
      kind: 'tickets.addNote',
      payload: { ticketId: 't1', comment: 'Заменил блок питания' },
      label: 'WSP-6472',
    });
    expect(d.copyText).toContain('WSP-6472');
    expect(d.copyText).toContain('Заменил блок питания');
  });
});
