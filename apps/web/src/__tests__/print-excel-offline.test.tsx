/**
 * Печать и выгрузка в Excel не виснут навсегда при потере связи.
 *
 * ЧТО БЫЛО. Четыре места собирают файл, дотягивая данные императивным
 * `utils.<путь>.fetch()` прямо в обработчике кнопки:
 *   • «Итог дня» на главной — печать и Excel;
 *   • журнал кассы — Excel по всему фильтру, страницами;
 *   • отчёты — Excel «Аналитика за период», шесть разделов сразу;
 *   • карточка счёта — печать (наряд, клиент, заявка).
 *
 * 🔴 При настоящем офлайне react-query не роняет такой запрос, а СТАВИТ ЕГО НА
 * ПАУЗУ: обещание не завершается никогда, `catch` и `finally` не срабатывают.
 * Кнопка навсегда остаётся «Собираю…», человек ждёт файл, которого не будет.
 * Ровно так намертво вешался сканер заявок (#112). У выгрузки «Итог дня» в
 * Excel не было даже `catch` — только `finally`, который тоже не срабатывал.
 *
 * ⚠️ НАСТОЯЩИЙ ОФЛАЙН В ТЕСТЕ — это подмена `navigator.onLine` И обещание,
 * которое никогда не завершается. Выключенный сервер офлайном НЕ является:
 * тогда `navigator.onLine === true`, запрос уходит и честно падает.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { OfflineFileError, assertOnlineForFile } from '../lib/offline/require-online';
import { CashJournalPage } from '../pages/CashJournalPage';

function setOnline(on: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: on });
  onlineManager.setOnline(on);
}

describe('assertOnlineForFile', () => {
  afterEach(() => setOnline(true));

  it('со связью молчит', () => {
    setOnline(true);
    expect(() => assertOnlineForFile('файл')).not.toThrow();
  });

  it('без связи бросает понятную ошибку, а не ждёт вечно', () => {
    setOnline(false);
    expect(() => assertOnlineForFile('журнал кассы')).toThrow(OfflineFileError);
    try {
      assertOnlineForFile('журнал кассы');
    } catch (e) {
      expect((e as Error).message).toContain('Нет связи');
      expect((e as Error).message).toContain('журнал кассы');
    }
  });
});

const TX = {
  items: [
    {
      id: 'ffffffff-0000-4000-8000-00000000c001',
      occurredOn: '2026-08-10',
      kind: 'income' as const,
      amountKopecks: '500000',
      accountName: 'Касса',
      categoryName: 'Оплата услуг',
      comment: null,
      counterpartyName: null,
    },
  ],
  total: 1,
};

/** Сколько раз экран сходил в сеть после нажатия «Excel». */
let netCalls = 0;

function renderCash() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  // Данные для таблицы кладём заранее: нас интересует только кнопка выгрузки.
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: (input) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          const paths = (url.split('/trpc/')[1] ?? '').split('?')[0]?.split(',') ?? [];
          netCalls++;
          const payload = paths.map((p) => ({
            result: {
              data: superjson.serialize(
                p === 'cash.transactions.list'
                  ? TX
                  : p === 'cash.accounts.list'
                    ? []
                    : p === 'cash.categories.list'
                      ? []
                      : p === 'auth.me'
                        ? { user: { id: 'u', role: 'director' }, tenant: {} }
                        : null,
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
        <CashJournalPage />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(() => {
  netCalls = 0;
  setOnline(true);
});

afterEach(() => {
  cleanup();
  setOnline(true);
});

describe('выгрузка журнала кассы без связи', () => {
  it('говорит человеку, что связи нет, и не остаётся в «Собираю…»', async () => {
    renderCash();
    // Ждём именно СТРОКУ, а не кнопку: кнопка есть и во время загрузки, но
    // выключена (`total === 0`), и клик по ней ничего бы не сделал.
    await screen.findByText(/5 000/);
    const button = await screen.findByRole('button', { name: /Excel/ });

    setOnline(false);
    netCalls = 0;
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText(/Нет связи с сервером/)).toBeTruthy());
    // Кнопка вернулась в рабочее состояние, а не «Собираю…» навсегда.
    expect(screen.queryByText('Собираю…')).toBeNull();
    // В сеть не пошли вовсе: на паузе обещание не завершилось бы никогда.
    expect(netCalls).toBe(0);
  });
});

/**
 * Остальные три места сторожим по исходнику: каждое тянет свой набор процедур,
 * а компонентный тест на «Итог дня» и «Аналитику» был бы дороже и хрупче самой
 * проверки (тот же приём, что у сторожа «на телефоне инженера нет рублей»).
 */
describe('остальные сборщики файлов спрашивают связь до запроса', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const PAGES = [
    '../pages/DashboardPage.tsx',
    '../pages/ReportsPage.tsx',
    '../pages/InvoiceCardPage.tsx',
  ];

  for (const page of PAGES) {
    it(`${page.split('/').pop()} зовёт assertOnlineForFile`, () => {
      const src = readFileSync(resolve(here, page), 'utf8');
      expect(src).toContain('assertOnlineForFile');
    });
  }

  it('у выгрузки «Итог дня» в Excel появился catch — раньше был только finally', () => {
    const src = readFileSync(resolve(here, '../pages/DashboardPage.tsx'), 'utf8');
    const xlsx = src.slice(src.indexOf('handleDailySummaryXlsx'));
    expect(xlsx.slice(0, xlsx.indexOf('finally'))).toMatch(/catch/);
  });
});
