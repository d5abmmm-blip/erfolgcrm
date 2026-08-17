/**
 * Блокировка сотрудника предупреждает о том, что уедет вместе с ним.
 *
 * ЧТО БЫЛО. Диалог говорил ровно одно: «вход будет закрыт, активные сессии
 * отозваны». А блокировка тянет за собой ещё два последствия, о которых человек
 * узнавал позже и порознь:
 *
 *   1. НЕЗАКРЫТЫЕ ЗАЯВКИ остаются на нём. Они не всплывают у других и не
 *      возвращаются в «без назначения» — просто висят за человеком, которого
 *      больше нет в системе.
 *   2. ВЕДОМОСТЬ ЗАРПЛАТЫ его больше не увидит. `loadAggregates` в
 *      payroll/repository.ts отбирает строки работ по `u.is_active = true`,
 *      поэтому из расчёта пропадает и то, что человек УЖЕ заработал в текущем
 *      месяце. Чтобы выплатить, его придётся временно вернуть в активные.
 *
 * Второе — денежное: заблокировали 20-го числа, посчитали ведомость 31-го, и
 * его работ в ней нет.
 *
 * Число заявок берём с сервера (`tickets.list` с фильтром по инженеру и
 * активными статусами), а не выдумываем: «возможно, есть незакрытые» — это не
 * предупреждение, а шум.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { BlockToggle } from '../pages/UsersPage';

const ENGINEER = {
  id: 'ffffffff-0000-4000-8000-0000000000a9',
  username: 'chulaev',
  fullName: 'Чулаев А. А.',
  position: 'инженер',
  email: null,
  phone: null,
  role: 'engineer' as const,
  isActive: true,
  lastLoginAt: null,
};

let openTickets = 0;
let sent: string[] = [];

function renderToggle(user = ENGINEER) {
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
          sent.push(...paths);
          const payload = paths.map((p) => ({
            result: {
              data: superjson.serialize(
                p === 'tickets.list' ? { items: [], total: openTickets } : null,
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
        <BlockToggle user={user} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(() => {
  openTickets = 0;
  sent = [];
});
afterEach(cleanup);

describe('диалог блокировки', () => {
  it('называет число незакрытых заявок сотрудника', async () => {
    openTickets = 3;
    renderToggle();

    fireEvent.click(screen.getByRole('button', { name: /Заблокировать/ }));

    await waitFor(() => expect(screen.getByText(/незакрыт/)).toBeTruthy());
    expect(screen.getByText(/3/)).toBeTruthy();
  });

  it('предупреждает про ведомость зарплаты', async () => {
    renderToggle();

    fireEvent.click(screen.getByRole('button', { name: /Заблокировать/ }));

    expect(await screen.findByText(/ведомост/i)).toBeTruthy();
  });

  it('незакрытых нет — про заявки не пугаем', async () => {
    openTickets = 0;
    renderToggle();

    fireEvent.click(screen.getByRole('button', { name: /Заблокировать/ }));

    await screen.findByText(/ведомост/i);
    expect(screen.queryByText(/незакрыт/)).toBeNull();
  });

  it('спрашиваем заявки только когда диалог открыт — список пользователей не дёргаем зря', () => {
    openTickets = 5;
    renderToggle();

    expect(sent.includes('tickets.list')).toBe(false);
  });

  it('разблокировка про заявки и ведомость не говорит — это про другое', async () => {
    openTickets = 4;
    renderToggle({ ...ENGINEER, isActive: false });

    fireEvent.click(screen.getByRole('button', { name: /Разблокировать/ }));

    expect(await screen.findByText(/снова сможет входить/)).toBeTruthy();
    expect(screen.queryByText(/незакрыт/)).toBeNull();
  });
});
