/**
 * Кабинет клиента: права по 152-ФЗ доступны кнопками, а не только через API.
 *
 * ЗАЧЕМ. Сервер давно умеет и выгрузку всех данных субъекта (exportMyData,
 * ст. 14), и запрос на удаление аккаунта (requestAccountDeletion, ст. 21) —
 * с аудитом, отзывом согласий и сессий. Но в кабинете не было ни одной
 * кнопки: docs/152-fz-compliance.md обещал «реализовано», а клиент мог
 * воспользоваться правами разве что через консоль браузера.
 *
 * Проверяем на профиле кабинета:
 *   1. «Скачать мои данные» действительно зовёт exportMyData;
 *   2. удаление аккаунта НЕ уходит с первого клика — только после
 *      явного подтверждения (действие выкидывает из кабинета сразу).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { ClientProfilePage } from '../pages/client/ClientProfilePage';

const ME = {
  user: {
    id: 'cu-1',
    fullName: 'Мадина Ахметовна',
    email: 'buh@gbu-hospital.ru',
    position: 'главный бухгалтер',
    phone: null,
  },
  client: { id: 'c-1', displayName: 'ГБУ «Городская больница №1»' },
};

let sent: { path: string; body: string }[] = [];

function answerFor(path: string): unknown {
  if (path === 'clientAuth.me') return ME;
  if (path === 'clientCabinet.exportMyData')
    return { generatedAt: '2026-08-17T00:00:00Z', profile: {}, tickets: [] };
  if (path === 'clientCabinet.requestAccountDeletion') return { ok: true };
  return null;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: (input, init) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          const paths = (url.split('/trpc/')[1] ?? '').split('?')[0]?.split(',') ?? [];
          for (const p of paths) sent.push({ path: p, body: String(init?.body ?? '') });
          const payload = paths.map((p) => ({
            result: { data: superjson.serialize(answerFor(p)) },
          }));
          return Promise.resolve(
            new Response(JSON.stringify(payload), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ClientProfilePage />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(() => {
  sent = [];
  // jsdom не умеет blob-URL — а скачивание файла строит именно их.
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('152-ФЗ в кабинете клиента', () => {
  it('«Скачать мои данные» зовёт exportMyData', async () => {
    renderPage();
    await screen.findByText('Мои данные');

    fireEvent.click(screen.getByRole('button', { name: /Скачать мои данные/ }));
    await waitFor(() => {
      expect(sent.some((s) => s.path === 'clientCabinet.exportMyData')).toBe(true);
    });
  });

  it('удаление аккаунта не уходит с первого клика — только после подтверждения', async () => {
    renderPage();
    await screen.findByText('Мои данные');

    fireEvent.click(screen.getByRole('button', { name: /Удалить мой аккаунт/ }));
    // Первый клик — только раскрывает объяснение с подтверждением.
    expect(sent.filter((s) => s.path === 'clientCabinet.requestAccountDeletion')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /Да, закрыть доступ/ }));
    await waitFor(() => {
      expect(sent.some((s) => s.path === 'clientCabinet.requestAccountDeletion')).toBe(true);
    });
  });
});
