/**
 * Фильтр списка заявок по инженеру.
 *
 * ЧТО БЫЛО. На карточке сотрудника, во вкладке «Работа», стоит ссылка
 * «Все заявки →». Она вела на `/tickets` — то есть на список заявок ВСЕЙ
 * КОМПАНИИ. Человек нажимал её из карточки конкретного инженера и получал
 * 6000 чужих строк; фильтра по инженеру в списке заявок не было вовсе, хотя
 * `tickets.list` принимает `engineerId` с самого начала.
 *
 * Читаем фильтр из адресной строки — тем же приёмом, что и статус счёта в #161
 * (`invoiceStatusFromQuery`): страница, которая не читает адрес, превращает
 * любую ссылку с плитки в «показать всё».
 *
 * Здесь два конца, и оба проверяем: ссылка на карточке сотрудника несёт
 * `engineerId`, а список заявок его понимает и передаёт серверу.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { TicketsListPage, engineerIdFromQuery } from '../pages/TicketsListPage';

const ENGINEER = 'ffffffff-0000-4000-8000-00000000e001';

describe('engineerIdFromQuery', () => {
  it('берёт инженера из адреса — тот самый переход с карточки сотрудника', () => {
    expect(engineerIdFromQuery(`?engineerId=${ENGINEER}`)).toBe(ENGINEER);
  });

  it('без параметра — заявки всей компании, как и было', () => {
    expect(engineerIdFromQuery('')).toBeNull();
    expect(engineerIdFromQuery('?page=2')).toBeNull();
  });

  it('мусор вместо идентификатора не притворяется фильтром', () => {
    // Иначе сервер ответит сырой ошибкой валидации вместо списка.
    expect(engineerIdFromQuery('?engineerId=кто-то')).toBeNull();
    expect(engineerIdFromQuery('?engineerId=')).toBeNull();
    expect(engineerIdFromQuery('?engineerId=12345')).toBeNull();
  });
});

const USERS = [
  { id: ENGINEER, fullName: 'Чулаев А. А.', role: 'engineer', isActive: true },
  {
    id: 'ffffffff-0000-4000-8000-00000000e002',
    fullName: 'Алероев А. А.',
    role: 'engineer',
    isActive: true,
  },
];

let sent: { path: string; url: string }[] = [];

function answerFor(path: string): unknown {
  if (path === 'tickets.list') return { items: [], total: 0 };
  if (path === 'users.list') return USERS;
  if (path === 'auth.me') return { user: { id: 'u-dir', role: 'director' }, tenant: {} };
  return null;
}

function renderList(search: string) {
  window.history.pushState({}, '', `/tickets${search}`);
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
          for (const p of paths) sent.push({ path: p, url });
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
        <TicketsListPage />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(() => {
  sent = [];
});
afterEach(cleanup);

describe('список заявок с фильтром по инженеру', () => {
  it('спрашивает у сервера заявки именно этого инженера', async () => {
    renderList(`?engineerId=${ENGINEER}`);

    await waitFor(() =>
      expect(sent.some((s) => s.path === 'tickets.list' && s.url.includes(ENGINEER))).toBe(true),
    );
  });

  it('пишет, чьи заявки показаны, и даёт вернуться ко всем', async () => {
    renderList(`?engineerId=${ENGINEER}`);

    expect(await screen.findByText(/Чулаев А. А./)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Показать все заявки/ })).toBeTruthy();
  });

  it('без параметра фильтра нет и серверу инженер не передаётся', async () => {
    renderList('');

    await waitFor(() => expect(sent.some((s) => s.path === 'tickets.list')).toBe(true));
    const call = sent.find((s) => s.path === 'tickets.list');
    // Само слово engineerId в адресе есть всегда: superjson перечисляет в meta
    // и незаполненные поля. Значит смотрим на ЗНАЧЕНИЕ — его быть не должно.
    expect(call?.url.includes(ENGINEER)).toBe(false);
    expect(screen.queryByRole('button', { name: /Показать все заявки/ })).toBeNull();
  });
});

describe('ссылка с карточки сотрудника', () => {
  it('«Все заявки →» ведёт на заявки ЭТОГО инженера, а не всей компании', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../components/StaffWorkTab.tsx'), 'utf8');
    expect(src).toMatch(/\/tickets\?engineerId=\$\{/);
  });
});
