/**
 * Экран «Не отправлено».
 *
 * Раньше отклонённая сервером правка исчезала, а человек видел одно число.
 * Здесь стережём, что он видит: что это было, что он написал и почему не ушло.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { clearAll, enqueue, listPending } from '../lib/offline/queue';
import { setCurrentUserId } from '../lib/offline/current-user';
import { syncOutbox } from '../lib/offline/executor';
import { OutboxRejectedList } from '../components/OutboxRejectedList';
import { TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@erfolg/api';

function rejection(message: string) {
  return new TRPCClientError<AppRouter>(message, {
    result: {
      error: {
        code: -32600,
        message,
        data: { code: 'BAD_REQUEST', httpStatus: 400, path: 'tickets.addNote' },
      },
    },
  } as never);
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId('engineer-A');
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
});

afterEach(async () => {
  cleanup();
  setCurrentUserId(null);
  await clearAll();
});

describe('«Не отправлено»', () => {
  it('показывает, что именно не ушло и почему', async () => {
    await enqueue(
      'tickets.addNote',
      { ticketId: 't1', comment: 'Заменил блок питания, аппарат запустился' },
      'erfolg',
      undefined,
      'WSP-6472',
    );
    await syncOutbox(vi.fn().mockRejectedValue(rejection('Заявка уже закрыта')));

    render(<OutboxRejectedList onRetryAll={() => undefined} />);

    expect(await screen.findByText('Комментарий к заявке WSP-6472')).toBeTruthy();
    // Текст, который инженер набирал руками, — на месте.
    expect(screen.getByText('Заменил блок питания, аппарат запустился')).toBeTruthy();
    expect(screen.getByText(/Заявка уже закрыта/)).toBeTruthy();
    expect(screen.getByText('Повторить')).toBeTruthy();
    expect(screen.getByText('Скопировать')).toBeTruthy();
  });

  it('пока всё в порядке — блок не мешается на экране', async () => {
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'ждёт связи' }, 'erfolg');

    const { container } = render(<OutboxRejectedList onRetryAll={() => undefined} />);

    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('чужую запись показывает, но кнопок не даёт', async () => {
    setCurrentUserId('engineer-A');
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'писал А' }, 'erfolg');
    setCurrentUserId('engineer-B');

    render(<OutboxRejectedList onRetryAll={() => undefined} />);

    expect(await screen.findByText(/другим сотрудником/)).toBeTruthy();
    expect(screen.queryByText('Повторить')).toBeNull();
    // И главное — она никуда не делась.
    expect(await listPending()).toHaveLength(1);
  });
});

/**
 * Слушателей очереди трое (оболочка, профиль, фоновый автосинк), и каждый
 * зовёт отправку сам. Без склейки человек получал ТРИ одинаковых красных
 * сообщения подряд — выглядит как поломка. Проверено вживую.
 */
describe('одинаковые сообщения не дублируются', () => {
  it('повтор того же текста подряд показывается один раз', async () => {
    const { showToast, subscribeToasts } = await import('../lib/toast');
    const seen: string[] = [];
    const unsub = subscribeToasts((t) => seen.push(t.text));

    showToast('error', 'Вход в систему закончился');
    showToast('error', 'Вход в систему закончился');
    showToast('error', 'Вход в систему закончился');
    unsub();

    expect(seen).toEqual(['Вход в систему закончился']);
  });

  it('разные сообщения проходят все', async () => {
    const { showToast, subscribeToasts } = await import('../lib/toast');
    const seen: string[] = [];
    const unsub = subscribeToasts((t) => seen.push(t.text));

    showToast('error', 'Первое');
    showToast('ok', 'Второе');
    unsub();

    expect(seen).toEqual(['Первое', 'Второе']);
  });
});
