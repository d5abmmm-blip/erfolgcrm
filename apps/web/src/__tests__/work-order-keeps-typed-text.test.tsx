/**
 * Набранное в наряде не пропадает при уходе с экрана.
 *
 * НАХОДКА РАЗБОРА: наряд пишет по уходу курсора из поля — и это единственный
 * момент записи. Телефонное «назад» и сворачивание приложения курсор из поля
 * не выводят: экран просто убирают, набранное остаётся в оперативной памяти
 * вкладки и исчезает вместе с ней. По всему `apps/web/src` не было НИ ОДНОГО
 * обработчика ухода со страницы (`pagehide`/`visibilitychange`).
 *
 * Цена молчания: инженер набрал описание ремонта в подвале, нажал «назад»
 * посмотреть телефон клиента — работа не попала ни в счёт клиенту, ни в его
 * зарплату (сделка считается от строки наряда), и никто об этом не узнал.
 *
 * Сюда же «ИИ-черновик»: кнопка вписывает текст в поле, но курсор в поле не
 * встаёт, поэтому уходить оттуда нечему.
 *
 * ПОЧЕМУ ПРОВЕРЯЕМ ЧЕРЕЗ ОЧЕРЕДЬ: тесты идут в режиме «нет связи», и запись
 * обязана лечь в оффлайн-очередь. Это же и есть обещание пользователю —
 * «уйдёт, когда появится сеть». Заодно видно САМ ТЕКСТ: проверяем, что
 * сохранилось именно набранное, а не пустота.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { WorkOrderEditor } from '../components/WorkOrderEditor';
import { clearAll, listPending } from '../lib/offline/queue';
import { setCurrentUserId } from '../lib/offline/current-user';

const TICKET = 'ffffffff-0000-4000-8000-00000000bbbb';

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

/**
 * Заглушка сервера: ИИ-черновик отдаёт текст, а сохранение падает сетевой
 * ошибкой — как в подвале. Так проверяем ровно то, что нужно: текст в поле
 * появился «не руками», и всё равно обязан пережить уход с экрана.
 */
function serverDraftsButCannotSave() {
  return (url: unknown): Promise<Response> => {
    const address = String(url);
    if (address.includes('draftRepairDescription')) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { result: { data: { json: { text: 'Заменена плата питания', aiUsed: true } } } },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    if (address.includes('getByTicket')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ result: { data: { json: WORK_ORDER } } }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.reject(new TypeError('Failed to fetch'));
  };
}

function renderEditor(fetchImpl?: (url: unknown) => Promise<Response>) {
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
        <WorkOrderEditor ticketId={TICKET} ticketNumber="WSP-778" canEdit canEditVat={false} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

/** Что накопилось в очереди по этому наряду — вместе с текстом. */
async function queuedPayloads(): Promise<Array<{ kind: string; payload: unknown }>> {
  const items = await listPending();
  return items.map((i) => ({ kind: i.kind, payload: i.payload }));
}

/** Телефон свернули: браузер говорит об этом только событием видимости. */
function hidePage(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

function showPage(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId('engineer-A');
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  onlineManager.setOnline(false);
});

afterEach(async () => {
  cleanup();
  showPage();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
  setCurrentUserId(null);
  await clearAll();
});

describe('уход с экрана не стирает набранное', () => {
  it('нажал «назад», не выходя из поля — текст сохранён', async () => {
    const view = renderEditor();
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;

    // Печатает и НЕ уходит из поля — именно так теряли работу.
    fireEvent.change(field, { target: { value: 'Пробой платы питания' } });
    view.unmount();

    await waitFor(async () => {
      const queued = await queuedPayloads();
      expect(queued.some((q) => JSON.stringify(q.payload).includes('Пробой платы питания'))).toBe(
        true,
      );
    });
  });

  it('свернул приложение — текст сохранён, не дожидаясь возврата', async () => {
    renderEditor();
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;

    fireEvent.change(field, { target: { value: 'Не включается после грозы' } });
    hidePage();

    await waitFor(async () => {
      const queued = await queuedPayloads();
      expect(
        queued.some((q) => JSON.stringify(q.payload).includes('Не включается после грозы')),
      ).toBe(true);
    });
  });

  it('строка наряда — тоже деньги, и тоже не пропадает', async () => {
    const view = renderEditor();
    const [addRow] = await screen.findAllByRole('button', { name: /Добавить строку/ });
    fireEvent.click(addRow!);

    const name = await screen.findByPlaceholderText('Что выполнено');
    fireEvent.change(name, { target: { value: 'Замена платы питания' } });
    view.unmount();

    await waitFor(async () => {
      const queued = await queuedPayloads();
      expect(
        queued.some(
          (q) =>
            q.kind === 'workOrders.upsertLine' &&
            JSON.stringify(q.payload).includes('Замена платы питания'),
        ),
      ).toBe(true);
    });
  });

  it('текст ИИ-черновика переживает уход, хотя курсор в поле не вставал', async () => {
    const view = renderEditor(serverDraftsButCannotSave());
    fireEvent.click(await screen.findByRole('button', { name: /ИИ-черновик/ }));

    // Кнопка вписывает текст в поле, но фокус остаётся на кнопке.
    await screen.findByDisplayValue('Заменена плата питания');
    view.unmount();

    await waitFor(async () => {
      const queued = await queuedPayloads();
      expect(queued.some((q) => JSON.stringify(q.payload).includes('Заменена плата питания'))).toBe(
        true,
      );
    });
  });
});

describe('запись при уходе не выдумывает лишнего', () => {
  /**
   * Обратная проверка, без неё правка опасна: если бы уход с экрана слал
   * запись всегда, наряд получал бы пустые правки при каждом открытии
   * карточки — а у строк это ещё и дубли, то есть задвоенные деньги.
   */
  it('ушёл, ничего не тронув — в очереди пусто', async () => {
    const view = renderEditor();
    await screen.findAllByRole('textbox');
    view.unmount();

    await new Promise((r) => setTimeout(r, 50));
    expect(await queuedPayloads()).toHaveLength(0);
  });

  it('текст не изменился — записи нет', async () => {
    const view = renderEditor();
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;

    // Ткнул в поле, поправил и вернул как было.
    fireEvent.change(field, { target: { value: 'что-то' } });
    fireEvent.change(field, { target: { value: '' } });
    view.unmount();

    await new Promise((r) => setTimeout(r, 50));
    expect(await queuedPayloads()).toHaveLength(0);
  });
});
