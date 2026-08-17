/**
 * График ТО можно поправить и выключить.
 *
 * ЧТО БЫЛО. `maintenance.updateSchedule` умеет менять тип, интервал,
 * ответственного, заметку и признак «активен» — и не звался НИГДЕ. Заведённый
 * с ошибкой график (не тот интервал, не тот аппарат) оставался навсегда: он
 * висел в «Просрочено», крутил счётчик в меню, и убрать его можно было только
 * списанием самой техники.
 *
 * Сервер умеет и фильтр `inactive`, но вкладки под него не было — значит
 * выключенный график исчезал бы совсем, без пути назад. Поэтому вкладка
 * «Выключенные» появляется вместе с самой кнопкой выключения, а не отдельно.
 *
 * ПОЧЕМУ НАСТОЯЩИЙ ЭКРАН, А НЕ ЗАГЛУШКА: подставной tRPC отдаёт
 * `superjson.serialize` по именам процедур из пути, поэтому страница ходит
 * своими настоящими запросами, а тест видит, что именно она отправила.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { MaintenancePage } from '../pages/MaintenancePage';

const DAY = 24 * 60 * 60 * 1000;

const SCHEDULE = {
  id: 'ffffffff-0000-4000-8000-0000000000a1',
  assetId: 'ffffffff-0000-4000-8000-0000000000a2',
  assetModel: 'Аппарат ИВЛ Puritan Bennett 840',
  assetSerial: 'PB840-0091',
  clientId: 'ffffffff-0000-4000-8000-0000000000a3',
  clientName: 'ГБУ «Городская больница №1»',
  kind: 'planned' as const,
  intervalDays: 365,
  lastDoneAt: null as Date | null,
  nextDueAt: new Date(Date.now() - 10 * DAY),
  responsibleUserId: null as string | null,
  notes: 'по договору',
  isActive: true,
  isOverdue: true,
  createdAt: new Date('2026-01-10T10:00:00Z'),
  updatedAt: new Date('2026-01-10T10:00:00Z'),
};

const ME = {
  user: { id: 'u-dir', role: 'director', username: 'director', fullName: 'Директор' },
  tenant: { displayName: 'ООО «Эрфольг»' },
};

/** Что экран отправил: путь процедуры и тело (у мутаций) или входные данные. */
let sent: { path: string; body: string; url: string }[] = [];

/** Ответ подставного сервера на один вызов процедуры. */
function answerFor(path: string): unknown {
  if (path === 'auth.me') return ME;
  if (path === 'maintenance.listSchedules') return [SCHEDULE];
  if (path === 'maintenance.listLog') return [];
  // Мутации и всё прочее — «сделано».
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
          for (const p of paths) sent.push({ path: p, body: String(init?.body ?? ''), url });
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
        <MaintenancePage />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

/** Первый запрос к указанной процедуре. */
function callTo(path: string): { path: string; body: string; url: string } {
  const c = sent.find((s) => s.path === path);
  if (!c)
    throw new Error(`экран не обращался к ${path}; были: ${sent.map((s) => s.path).join(', ')}`);
  return c;
}

beforeEach(() => {
  sent = [];
});

afterEach(cleanup);

describe('правка графика ТО', () => {
  it('у графика есть «Изменить», форма открывается с текущим интервалом', async () => {
    renderPage();
    await screen.findByText(/Puritan Bennett 840/);

    fireEvent.click(screen.getByRole('button', { name: /Изменить график/ }));

    expect(await screen.findByDisplayValue('365')).toBeTruthy();
    // Аппарат в правке не меняется — сервер такого поля не принимает, и форма
    // показывает его только для сверки (потому модель теперь видна дважды:
    // в строке таблицы и в открытой форме).
    expect(screen.getByText(/Техника у графика не меняется/)).toBeTruthy();
    expect(screen.getAllByText(/Puritan Bennett 840/).length).toBeGreaterThan(1);
  });

  it('новый интервал уходит как maintenance.updateSchedule', async () => {
    renderPage();
    await screen.findByText(/Puritan Bennett 840/);

    fireEvent.click(screen.getByRole('button', { name: /Изменить график/ }));
    const interval = await screen.findByDisplayValue('365');
    fireEvent.change(interval, { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: /^Сохранить$/ }));

    await waitFor(() =>
      expect(sent.some((s) => s.path === 'maintenance.updateSchedule')).toBe(true),
    );
    const call = callTo('maintenance.updateSchedule');
    expect(call.body).toContain('180');
    expect(call.body).toContain(SCHEDULE.id);
  });
});

describe('выключение графика', () => {
  it('спрашивает подтверждение и до ответа ничего не шлёт', async () => {
    renderPage();
    await screen.findByText(/Puritan Bennett 840/);

    fireEvent.click(screen.getByRole('button', { name: /Выключить график/ }));

    expect(await screen.findByText(/Выключить график ТО/)).toBeTruthy();
    expect(sent.some((s) => s.path === 'maintenance.updateSchedule')).toBe(false);
  });

  it('подтвердил — уходит isActive: false', async () => {
    renderPage();
    await screen.findByText(/Puritan Bennett 840/);

    fireEvent.click(screen.getByRole('button', { name: /Выключить график/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Выключить$/ }));

    await waitFor(() =>
      expect(sent.some((s) => s.path === 'maintenance.updateSchedule')).toBe(true),
    );
    expect(callTo('maintenance.updateSchedule').body).toContain('false');
  });
});

describe('вкладка «Выключенные»', () => {
  it('есть, и запрашивает у сервера именно выключенные', async () => {
    renderPage();
    await screen.findByText(/Puritan Bennett 840/);

    fireEvent.click(screen.getByRole('button', { name: /Выключенные/ }));

    await waitFor(() =>
      expect(
        sent.some((s) => s.path === 'maintenance.listSchedules' && s.url.includes('inactive')),
      ).toBe(true),
    );
  });
});
