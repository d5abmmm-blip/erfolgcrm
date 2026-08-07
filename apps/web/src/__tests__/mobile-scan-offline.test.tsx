/**
 * Сканер работает без связи — и, главное, НЕ ЗАВИСАЕТ.
 *
 * ЧТО БЫЛО (измерено в браузере, не выведено рассуждением). Поиск заявки по
 * коду шёл императивным `utils.tickets.search.fetch()` прямо в обработчике.
 * У ЗАПРОСОВ (в отличие от мутаций, см. query-defaults) режим по умолчанию
 * `networkMode: 'online'`: при настоящем офлайне react-query запрос не
 * отправляет, а СТАВИТ НА ПАУЗУ — обещание не выполняется и не отклоняется,
 * висит вечно. Ни `catch`, ни `finally` не срабатывают.
 *
 * На экране это выглядело так: инженер навёл на штрих-код → камера погасла
 * (её гасят до поиска) → «Ищем заявку…» навсегда. Кнопка «Найти» тоже заперта
 * (`disabled={searching}`). Выход — только перезапуск приложения. Ровно там,
 * где связи чаще всего и нет: подвал, экранированный кабинет КТ.
 *
 * Это вторая половина ловушки из PR #104: тогда починили мутации
 * (`networkMode: 'always'`), а сторона запросов осталась. Почему не ловилось
 * раньше — выключенный сервер это НЕ офлайн: тогда `navigator.onLine === true`,
 * запрос честно падает, и всё выглядит рабочим.
 *
 * ЧТО ДОЛЖНО БЫТЬ. Без связи ищем по заявкам, уже лежащим в памяти телефона
 * (`tickets.myList` сохраняется на диск — см. persisted-queries), и говорим об
 * этом словами. Сеть при этом не трогаем вовсе.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { MobileScanPage } from '../pages/mobile/MobileScanPage';
import { collectCachedTickets, findLocalScanMatches } from '../lib/scan-local';

const TICKET_ID = 'ffffffff-0000-4000-8000-00000000bbbb';
const BARCODE = 'T0123456789abcdef0123456789abcdef0';

/** Заявка в том виде, в каком её кладёт на диск `tickets.myList`. */
const CACHED_TICKET = {
  id: TICKET_ID,
  ticketNumber: 'WSP-6472',
  status: 'in_progress',
  priority: 'normal',
  repairType: 'repair',
  clientId: 'client-1',
  clientDisplayName: 'ГБУ «Городская больница №1»',
  assetId: 'asset-1',
  assetModel: 'Рентген-аппарат РДК',
  assetSerialNumber: 'SN-77',
  assetInventoryNumber: 'ИНВ-104',
  barcode: BARCODE,
  assignedEngineerId: 'user-me',
  assignedEngineerName: 'Я',
  slaTargetAt: null,
  deadlineAt: null,
  receivedAt: new Date('2026-08-01T09:00:00Z'),
  createdAt: new Date('2026-08-01T09:00:00Z'),
  waitingForPart: false,
  idleDays: 0,
};

/** Ровно то, что делает выключенное радио: и флаг браузера, и шина react-query. */
function goOffline() {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  onlineManager.setOnline(false);
}

function renderScanPage() {
  window.history.pushState({}, '', '/m/scan');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  // Список заявок, который приложение сохранило, пока связь была.
  queryClient.setQueryData(
    [
      ['tickets', 'myList'],
      {
        input: { statuses: ['received', 'diagnostics', 'in_progress'], pageSize: 50 },
        type: 'query',
      },
    ],
    { items: [CACHED_TICKET], total: 1 },
  );
  // Сеть в офлайне не должна дёргаться вовсе — следим за этим.
  const netCall = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
  const client = trpc.createClient({
    links: [
      httpLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: netCall,
      }),
    ],
  });
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <MobileScanPage />
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { netCall };
}

/** Ввод кода руками — тот же путь, что у распознанного камерой. */
function searchFor(code: string) {
  fireEvent.change(screen.getByPlaceholderText(/T-2026-000001/), { target: { value: code } });
  fireEvent.submit(screen.getByRole('button', { name: /Найти/ }).closest('form')!);
}

beforeEach(() => {
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe('инженер сканирует код там, где нет связи', () => {
  it('находит заявку по штрих-коду в памяти телефона и открывает её', async () => {
    goOffline();
    renderScanPage();

    searchFor(BARCODE);

    await waitFor(() => expect(window.location.pathname).toBe(`/m/tickets/${TICKET_ID}`));
  });

  it('не остаётся крутиться «Ищем заявку…» и не трогает сеть', async () => {
    goOffline();
    const { netCall } = renderScanPage();

    searchFor('ТАКОГО-КОДА-НЕТ');

    // Главное: спиннер уходит. До правки он висел вечно — обещание запроса
    // на паузе не завершается никогда, и `finally` не срабатывает.
    await waitFor(() => expect(screen.queryByText(/Ищем заявку/)).toBeNull());
    expect(netCall).not.toHaveBeenCalled();
  });

  /**
   * Ответ «не нашли» инженер должен УВИДЕТЬ.
   *
   * Найдено при этой же правке: сразу после установки текста вызывался
   * `startCamera()`, а он первым делом делал `setError(null)`. Сообщение
   * жило доли секунды — то есть код «просто не срабатывал», без единого слова.
   */
  it('говорит, что искал по памяти телефона, а не по всей базе', async () => {
    goOffline();
    renderScanPage();

    searchFor('ТАКОГО-КОДА-НЕТ');

    expect(await screen.findByText(/в памяти телефона/)).toBeTruthy();
  });
});

/** Правила сопоставления — без разметки и без сети. */
describe('поиск по сохранённым заявкам', () => {
  const local = [
    {
      id: 'a',
      ticketNumber: 'WSP-6472',
      clientDisplayName: 'Больница',
      assetModel: 'РДК',
      assetSerialNumber: 'SN-77',
      assetInventoryNumber: 'ИНВ-104',
      barcode: BARCODE,
    },
    {
      id: 'b',
      ticketNumber: 'WSP-6480',
      clientDisplayName: 'Больница',
      assetModel: 'УЗИ',
      assetSerialNumber: null,
      // У бюджетников серийника часто нет вообще — опознают по инвентарному.
      assetInventoryNumber: 'ИНВ-1040',
      barcode: 'T-другой-код',
    },
  ];

  it('находит по штрих-коду, серийному и инвентарному', () => {
    expect(findLocalScanMatches(local, BARCODE).map((m) => m.id)).toEqual(['a']);
    expect(findLocalScanMatches(local, 'sn-77').map((m) => m.id)).toEqual(['a']);
    expect(findLocalScanMatches(local, 'ИНВ-1040').map((m) => m.id)).toEqual(['b']);
  });

  it('точное совпадение не тонет среди похожих', () => {
    // «ИНВ-104» — это целиком инвентарный первой заявки и НАЧАЛО второй.
    // Без приоритета точного совпадения инженер получал бы выбор из двух там,
    // где ответ один.
    expect(findLocalScanMatches(local, 'ИНВ-104').map((m) => m.id)).toEqual(['a']);
    expect(findLocalScanMatches(local, 'WSP-64').map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('пустой запрос ничего не находит', () => {
    expect(findLocalScanMatches(local, '   ')).toEqual([]);
  });

  it('переживает мусор в сохранённом ответе и склеивает страницы по id', () => {
    // На диске лежит по записи на каждый набор фильтров, плюс данные могли
    // пролежать неделю и оказаться какой угодно формы — падать здесь нельзя.
    const tickets = collectCachedTickets([
      null,
      { items: 'не массив' },
      { items: [{ id: 'a', ticketNumber: 'WSP-6472' }, { нет: 'полей' }] },
      {
        items: [
          { id: 'a', ticketNumber: 'WSP-6472' },
          { id: 'c', ticketNumber: 'WSP-9' },
        ],
      },
    ]);
    expect(tickets.map((t) => t.id)).toEqual(['a', 'c']);
    expect(tickets[0]!.barcode).toBeNull();
  });
});
