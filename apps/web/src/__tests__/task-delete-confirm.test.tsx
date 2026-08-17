/**
 * Задача не удаляется одним кликом — корзинка сперва спрашивает.
 *
 * ЗАЧЕМ. В панели «Задачи» на календаре корзинка в строке звала
 * tasks.delete сразу по клику: промахнулся мимо соседнего карандаша —
 * задача исчезла без вопросов и без корзины восстановления. У событий
 * календаря и у диалога правки задачи двухшаговое «Точно удалить?» уже
 * было — быстрый путь из списка остался единственным без страховки.
 *
 * ПОСЛЕ ПРАВКИ. Первый клик взводит подтверждение (кнопка превращается
 * в «Точно?»), удаляет только второй.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { CalendarTasksPanel } from '../components/CalendarTasksPanel';

const TASK = {
  id: 'ffffffff-0000-4000-8000-0000000000b1',
  title: 'Позвонить в СЭС по поверке',
  notes: null,
  dueDate: null,
  dueTime: null,
  assigneeUserId: null,
  assigneeName: null,
  isDone: false,
  doneAt: null,
  remind: false,
  createdByUserId: null,
};

/** Что экран отправил: путь процедуры и тело. */
let sent: { path: string; body: string }[] = [];

function answerFor(path: string): unknown {
  if (path === 'tasks.list') return [TASK];
  return null;
}

function renderPanel() {
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
        <CalendarTasksPanel />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(() => {
  sent = [];
});

afterEach(cleanup);

describe('удаление задачи из списка', () => {
  it('первый клик по корзинке НЕ удаляет — только взводит «Точно?»', async () => {
    renderPanel();
    await screen.findByText('Позвонить в СЭС по поверке');

    fireEvent.click(screen.getByLabelText('Удалить задачу'));
    expect(sent.filter((s) => s.path === 'tasks.delete')).toEqual([]);
    // Задача на месте, кнопка ждёт подтверждения.
    expect(screen.getByText('Позвонить в СЭС по поверке')).toBeTruthy();
    expect(screen.getByLabelText('Точно удалить задачу?')).toBeTruthy();
  });

  it('второй клик — подтверждение, удаление уходит на сервер', async () => {
    renderPanel();
    await screen.findByText('Позвонить в СЭС по поверке');

    fireEvent.click(screen.getByLabelText('Удалить задачу'));
    fireEvent.click(screen.getByLabelText('Точно удалить задачу?'));
    await waitFor(() => {
      expect(sent.some((s) => s.path === 'tasks.delete')).toBe(true);
    });
  });
});
