/**
 * Поиск по номеру счёта уходит на сервер.
 *
 * ЧТО БЫЛО. Строка поиска фильтровала уже полученные 25 строк ТЕКУЩЕЙ страницы:
 * `items.filter(inv => inv.invoiceNumber.toLowerCase().includes(debounced))`.
 * Серверу поиск не передавался — у `listForTenant` такого параметра не было.
 * Итог под таблицей при этом приходил ОБЩИЙ. Человек вводил номер счёта,
 * лежащего на третьей странице, видел «Счетов не найдено» и «всего 120» под
 * пустой таблицей — и делал вывод, что счёта в программе нет.
 *
 * Здесь сторожим ровно это: экран отправляет введённое серверу и не режет
 * выдачу сам.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { InvoicesPage } from '../pages/InvoicesPage';

const ROW = {
  id: 'ffffffff-0000-4000-8000-00000000f001',
  invoiceNumber: 'СЧ-0007',
  status: 'issued' as const,
  totalAmountKopecks: '10000000',
  paidAmountKopecks: '0',
  dueDate: '2026-08-30',
  ticketId: 'ffffffff-0000-4000-8000-00000000f002',
};

let sent: { path: string; url: string }[] = [];

function renderPage() {
  window.history.pushState({}, '', '/invoices');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: (input) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          const paths = (url.split('/trpc/')[1] ?? '').split('?')[0]?.split(',') ?? [];
          for (const p of paths) sent.push({ path: p, url: decodeURIComponent(url) });
          const payload = paths.map((p) => ({
            result: {
              data: superjson.serialize(
                p === 'invoices.listForTenant' ? { items: [ROW], total: 1 } : null,
              ),
            },
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
        <InvoicesPage />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(() => {
  sent = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('поиск по номеру счёта', () => {
  it('введённое уходит на сервер, а не режет открытую страницу', async () => {
    renderPage();
    await screen.findByText('СЧ-0007');

    fireEvent.change(screen.getByPlaceholderText(/Поиск по номеру счёта/), {
      target: { value: 'СЧ-0007' },
    });
    // Ввод придерживается на 300 мс, чтобы не дёргать сервер на каждую букву.
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() =>
      expect(
        sent.some((s) => s.path === 'invoices.listForTenant' && s.url.includes('СЧ-0007')),
      ).toBe(true),
    );
  });

  it('строка, которой нет на открытой странице, всё равно уходит серверу', async () => {
    renderPage();
    await screen.findByText('СЧ-0007');

    fireEvent.change(screen.getByPlaceholderText(/Поиск по номеру счёта/), {
      target: { value: 'СЧ-9999' },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() =>
      expect(
        sent.some((s) => s.path === 'invoices.listForTenant' && s.url.includes('СЧ-9999')),
      ).toBe(true),
    );
  });

  it('пока не искали — серверу поиск не передаётся', async () => {
    renderPage();
    await screen.findByText('СЧ-0007');

    const first = sent.find((s) => s.path === 'invoices.listForTenant');
    expect(first?.url.includes('СЧ-')).toBe(false);
  });
});
