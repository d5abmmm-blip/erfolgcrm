/**
 * Липкая панель фильтров в мобильных экранах инженера (/m/queue, /m/tasks).
 *
 * Баг с телефона инженера: панель «Активные | Все» висела на 56px НИЖЕ своего
 * места, наезжала на баннер «Получать push о новых заявках?», а в щели между
 * тёмной шапкой и панелью просвечивал скроллящийся контент.
 *
 * Причина: окно в приложении вообще не скроллится (globals.css:
 * html, body { overflow: hidden }) — единственный скролл-контейнер это <main>
 * оболочки MobileShell, и начинается он СРАЗУ ПОД шапкой. Панель же прилипала
 * как `top-14` («отступи 56px под шапку»), будто скроллится окно и шапку надо
 * объехать. Внутри <main> шапки нет, поэтому sticky-элемент с top-14 постоянно
 * держится на 56px ниже верха скролл-порта — даже без прокрутки.
 *
 * Стережём: панель прилипает к верху скролл-контейнера (top-0) и непрозрачна
 * (bg-card) — иначе контент снова будет виден «за бампером».
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

/** Рендер с tRPC-контекстом, у которого сеть «вечно грузится» — данные тесту не нужны. */
function renderWithTrpc(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: () => new Promise(() => undefined),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </trpc.Provider>,
  );
}

function expectPinnedToScrollportTop(toolbar: Element | null) {
  expect(toolbar).not.toBeNull();
  const cls = toolbar?.className ?? '';
  // К верху <main>, а не «на 56px ниже под несуществующую шапку».
  expect(cls).toContain('top-0');
  expect(cls).not.toContain('top-14');
  // Непрозрачный фон: сквозь панель не должен просвечивать контент.
  expect(cls).toContain('bg-card');
}

describe('панель фильтров /m/queue', () => {
  it('прилипает к верху скролл-контейнера, а не висит на 56px ниже', () => {
    renderWithTrpc(<MobileQueuePage engineerId="engineer-1" />);
    const toolbar = screen.getByRole('button', { name: 'Активные' }).closest('.sticky');
    expectPinnedToScrollportTop(toolbar);
  });
});

describe('панель фильтров /m/tasks', () => {
  it('прилипает к верху скролл-контейнера, а не висит на 56px ниже', () => {
    renderWithTrpc(<MobileTasksPage />);
    const toolbar = screen.getByRole('button', { name: 'Открытые' }).closest('.sticky');
    expectPinnedToScrollportTop(toolbar);
  });
});
