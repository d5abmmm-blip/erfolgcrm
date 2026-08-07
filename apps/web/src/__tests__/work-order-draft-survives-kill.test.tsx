/**
 * Набранное переживает выбитое из памяти приложение.
 *
 * ИЗМЕРЕНО ЖИВОЙ ПРОВЕРКОЙ, а не предположено: запись при уходе с экрана
 * спасает «назад» и сворачивание, но НЕ спасает настоящую выгрузку страницы.
 * Событие приходит, а запись в IndexedDB асинхронная и умирает вместе со
 * страницей — после навигации с набранным текстом очередь оставалась пустой.
 *
 * Поэтому здесь другой инструмент: `localStorage` пишется СИНХРОННО, прямо в
 * обработчике нажатия клавиши. Он не заменяет отправку, а страхует её.
 *
 * Что должно получиться у инженера: телефон выбил приложение, он открыл его
 * заново, зашёл в тот же наряд — и текст на месте.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { WorkOrderEditor } from '../components/WorkOrderEditor';
import { clearAll } from '../lib/offline/queue';
import { setCurrentUserId } from '../lib/offline/current-user';
import { readDraft, rememberDraft, sweepDrafts } from '../lib/field-draft';

const TICKET = 'ffffffff-0000-4000-8000-00000000ffff';

const WORK_ORDER = {
  id: 'wo-1',
  orderNumber: 'WO-1',
  ticketId: TICKET,
  vatRate: '20' as const,
  diagnosis: null,
  repairDescription: null,
  recommendation: null,
  worksAmountKopecks: '0',
  partsAmountKopecks: '0',
  expensesAmountKopecks: '0',
  vatAmountKopecks: '0',
  totalAmountKopecks: '0',
  lines: [],
};

/** Сервер, который всё принимает — нужен для «принятый текст не воскресает». */
function serverOk() {
  return (url: unknown, init?: { method?: string }): Promise<Response> => {
    const address = String(url);
    const isWrite = (init?.method ?? 'GET').toUpperCase() === 'POST';
    const payload = isWrite ? { ok: true } : address.includes('getByTicket') ? WORK_ORDER : [];
    return Promise.resolve(
      new Response(JSON.stringify([{ result: { data: { json: payload } } }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

function renderEditor(fetchImpl?: (url: unknown, init?: { method?: string }) => Promise<Response>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  queryClient.setQueryData(
    [['workOrders', 'getByTicket'], { input: { ticketId: TICKET }, type: 'query' }],
    WORK_ORDER,
  );
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: fetchImpl ?? (() => Promise.reject(new TypeError('Failed to fetch'))),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkOrderEditor ticketId={TICKET} ticketNumber="WSP-781" canEdit canEditVat={false} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

/** Поле «Диагноз» — первое текстовое поле наряда. */
async function diagnosisField(): Promise<HTMLTextAreaElement> {
  const all = await screen.findAllByRole<HTMLTextAreaElement>('textbox');
  return all[0]!;
}

beforeEach(async () => {
  window.localStorage.clear();
  await clearAll();
  setCurrentUserId('engineer-A');
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  onlineManager.setOnline(false);
});

afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
  setCurrentUserId(null);
  await clearAll();
});

describe('черновик пишется сразу, не дожидаясь ухода', () => {
  it('каждая буква оседает в памяти телефона', async () => {
    renderEditor();
    const field = await diagnosisField();

    fireEvent.change(field, { target: { value: 'Пробой платы' } });

    expect(readDraft(TICKET, 'diagnosis')).toBe('Пробой платы');
  });
});

describe('приложение выбило из памяти', () => {
  /**
   * Так это и выглядит после того, как систему прибили: в памяти телефона
   * черновик есть, в очереди — пусто (записать не успело). Инженер открывает
   * наряд заново.
   */
  it('текст возвращается в поле при следующем открытии наряда', async () => {
    rememberDraft(TICKET, 'diagnosis', 'Не включается после грозы');

    renderEditor();
    const field = await diagnosisField();

    await waitFor(() => expect(field.value).toBe('Не включается после грозы'));
  });

  it('человеку сказано, что текст восстановлен, а не набран им сейчас', async () => {
    rememberDraft(TICKET, 'diagnosis', 'Не включается после грозы');

    renderEditor();

    expect(await screen.findByText(/восстановлен/i)).toBeTruthy();
  });
});

describe('черновик не воскресает поверх принятого', () => {
  it('сервер принял текст — черновика больше нет', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
    onlineManager.setOnline(true);

    renderEditor(serverOk());
    const field = await diagnosisField();

    fireEvent.change(field, { target: { value: 'Заменена плата' } });
    fireEvent.blur(field);

    await screen.findByText('записано');
    await waitFor(() => expect(readDraft(TICKET, 'diagnosis')).toBeNull());
  });

  it('ушёл в очередь — тоже больше не нужен: очередь его уже держит', async () => {
    renderEditor();
    const field = await diagnosisField();

    fireEvent.change(field, { target: { value: 'Ждёт связи' } });
    fireEvent.blur(field);

    await waitFor(() => expect(readDraft(TICKET, 'diagnosis')).toBeNull());
  });

  /**
   * Забытый черновик не должен всплыть через месяц поверх чужой работы.
   */
  it('протухший черновик не всплывает', async () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    window.localStorage.setItem(
      `erfolg-draft:${TICKET}:diagnosis`,
      JSON.stringify({ text: 'Забытый текст', at: old }),
    );

    renderEditor();
    const field = await diagnosisField();

    await new Promise((r) => setTimeout(r, 50));
    expect(field.value).toBe('');
  });
});

describe('память телефона не засоряется', () => {
  /**
   * Инженер за смену открывает десятки заявок. Без уборки в памяти телефона
   * копились бы черновики по каждой — включая давно закрытые.
   */
  it('уборка на старте выносит протухшие и не трогает свежие', () => {
    rememberDraft('ticket-свежий', 'diagnosis', 'ещё нужен');
    window.localStorage.setItem(
      'erfolg-draft:ticket-старый:diagnosis',
      JSON.stringify({ text: 'давно забыт', at: Date.now() - 30 * 24 * 60 * 60 * 1000 }),
    );
    // Битую запись тоже выносим: разобрать её всё равно нельзя.
    window.localStorage.setItem('erfolg-draft:ticket-битый:diagnosis', 'не json');

    expect(sweepDrafts()).toBe(2);
    expect(readDraft('ticket-свежий', 'diagnosis')).toBe('ещё нужен');
    expect(window.localStorage.getItem('erfolg-draft:ticket-старый:diagnosis')).toBeNull();
  });

  it('чужие ключи в хранилище не трогаем', () => {
    window.localStorage.setItem('erfolg-theme', 'dark');
    sweepDrafts();
    expect(window.localStorage.getItem('erfolg-theme')).toBe('dark');
  });
});
