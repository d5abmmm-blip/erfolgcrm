/**
 * Автосинк при «сеть есть, а сервер не отвечает» (досмотр №41, остаток).
 *
 * navigator.onLine видит только ЛОКАЛЬНУЮ сеть: Wi-Fi больницы жив, а наш
 * сервер недоступен (лёг, DNS, туннель). Круг отправки проваливается «мягко»,
 * запись остаётся sendable, завершение круга меняет isSyncing туда-обратно —
 * и тем же движением перезапускает эффект автосинка. Получается молотьба без
 * единой паузы: телефон греется, батарея тает, сервер добивается запросами.
 *
 * Ожидаемое поведение: неудачный круг → пауза, затем повтор; настоящее
 * событие «сеть вернулась» паузу снимает сразу.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../lib/offline/runner', () => ({
  runOutboxItem: vi.fn(),
  uploadPendingPhoto: vi.fn(),
}));

import { runOutboxItem } from '../lib/offline/runner';
import { useOutbox } from '../lib/offline/useOutbox';
import { clearAll, enqueue } from '../lib/offline/queue';
import { clearAllPhotos } from '../lib/offline/photo-queue';
import { setCurrentUserId } from '../lib/offline/current-user';

const runner = vi.mocked(runOutboxItem);

function setOnline(value: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  runner.mockReset();
  setOnline(true);
  setCurrentUserId(null);
  await clearAll();
  await clearAllPhotos();
});
afterEach(async () => {
  await clearAll();
  await clearAllPhotos();
});

describe('автосинк при лежащем сервере', () => {
  it('неудачный круг НЕ повторяется немедленно — между попытками пауза', async () => {
    runner.mockRejectedValue(new TypeError('Failed to fetch'));
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'из подвала' }, 'erfolg');

    const hook = renderHook(() => useOutbox(), { wrapper });
    await waitFor(() => expect(runner.mock.calls.length).toBeGreaterThanOrEqual(1));

    // Даём молотьбе шанс проявиться. С паузой (30 с) новых попыток быть не должно.
    await sleep(300);
    expect(runner.mock.calls.length).toBe(1);

    hook.unmount();
  });

  it('настоящее событие «сеть вернулась» снимает паузу сразу', async () => {
    runner.mockRejectedValue(new TypeError('Failed to fetch'));
    await enqueue('tickets.addNote', { ticketId: 't2', comment: 'ещё запись' }, 'erfolg');

    const hook = renderHook(() => useOutbox(), { wrapper });
    await waitFor(() => expect(runner.mock.calls.length).toBeGreaterThanOrEqual(1));
    await sleep(200);
    expect(runner.mock.calls.length).toBe(1); // пауза держит

    // Пропала и вернулась сеть — это новое знание о связи, пробуем немедленно.
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(runner.mock.calls.length).toBe(2));

    hook.unmount();
  });

  it('после паузы пробует сам, без событий и кнопок', async () => {
    runner.mockRejectedValue(new TypeError('Failed to fetch'));
    await enqueue('tickets.addNote', { ticketId: 't3', comment: 'третья' }, 'erfolg');

    // Тестовая пауза 150 мс, чтобы не ждать боевые 30 секунд.
    const hook = renderHook(() => useOutbox(150), { wrapper });
    await waitFor(() => expect(runner.mock.calls.length).toBeGreaterThanOrEqual(1));

    await sleep(80);
    expect(runner.mock.calls.length).toBe(1); // пауза ещё держит

    await waitFor(() => expect(runner.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });

    hook.unmount();
  });
});
