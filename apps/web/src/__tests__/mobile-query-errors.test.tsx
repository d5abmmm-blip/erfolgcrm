/**
 * Ошибки загрузки на мобильных экранах инженера.
 *
 * После PR #78 у приложения есть общий человеческий QueryError, но очередь и
 * задачи печатали сырой error.message (SQL/JSON могли просочиться наружу).
 * Стережём: при падении сети экраны показывают «Не удалось загрузить …».
 */
import { type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MobileQueuePage } from '../pages/mobile/MobileQueuePage';
import { MobileTasksPage } from '../pages/mobile/MobileTasksPage';

afterEach(cleanup);

/** tRPC-контекст, у которого каждый запрос падает как сетевая ошибка. */
function renderWithFailingTrpc(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </trpc.Provider>,
  );
}

describe('ошибка загрузки очереди (/m/queue)', () => {
  it('показывает человеческую плашку, а не сырой message', async () => {
    renderWithFailingTrpc(<MobileQueuePage engineerId="engineer-1" />);
    expect(await screen.findByText('Не удалось загрузить очередь заявок')).toBeTruthy();
  });
});

describe('ошибка загрузки задач (/m/tasks)', () => {
  it('показывает человеческую плашку, а не сырой message', async () => {
    renderWithFailingTrpc(<MobileTasksPage />);
    expect(await screen.findByText('Не удалось загрузить задачи')).toBeTruthy();
  });
});
