/**
 * Наряд на телефоне — карточки, а не сплющенная таблица.
 *
 * ЧТО БЫЛО (измерено в браузере на 375×812, а не прикинуто). Одна строка работ
 * рисовалась таблицей из семи колонок, и браузер ужимал её так:
 *   наименование 96 px (≈10 символов), «кто делал» 39 px, ед. 18 px,
 *   кол-во 28 px, ЦЕНА 31 px — «12500» не помещалось в собственное поле,
 *   плюс 88 px уезжало вбок под горизонтальный скролл.
 * Кнопка удаления строки — 14 × 14 px, вплотную к полю цены, БЕЗ ВОПРОСА и без
 * отмены. Это самый денежный экран приложения: строка наряда — и счёт клиенту,
 * и сделка в зарплате (30 % от строки).
 *
 * ЧТО ДОЛЖНО БЫТЬ. На телефоне строка — карточка во всю ширину: название
 * отдельной строкой, у каждого поля своя подпись (в таблице смысл нёс
 * заголовок колонки, в карточке его нет), удаление — через вопрос.
 *
 * ДЕСКТОП НЕ ТРОГАЕМ: там таблица удобна и проверена годами. Раскладку
 * выбирает экран, который открывает редактор, а не медиазапрос внутри него —
 * так на планшете в альбомной ориентации ничего не «переключится» само.
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

const TICKET = 'ffffffff-0000-4000-8000-00000000eeee';

const LINE = {
  id: 'line-1',
  lineType: 'work' as const,
  name: 'Замена блока питания рентген-аппарата',
  unit: 'шт',
  quantity: '1',
  unitPriceKopecks: '1250000',
  amountKopecks: '1250000',
  inventoryItemId: null,
  engineerId: null,
};

const WORK_ORDER = {
  id: 'wo-1',
  orderNumber: 'WO-1',
  ticketId: TICKET,
  vatRate: '5' as const,
  diagnosis: null,
  repairDescription: null,
  recommendation: null,
  worksAmountKopecks: '1250000',
  partsAmountKopecks: '0',
  expensesAmountKopecks: '0',
  vatAmountKopecks: '0',
  totalAmountKopecks: '1250000',
  lines: [LINE],
};

function renderEditor(layout?: 'table' | 'card') {
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
        // Связи нет — всё, что экран решит сохранить, ляжет в очередь и будет
        // видно вместе с числами.
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkOrderEditor
          ticketId={TICKET}
          ticketNumber="WSP-6472"
          canEdit
          canEditVat={false}
          layout={layout}
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

async function queuedKinds(): Promise<string[]> {
  return (await listPending()).map((i) => i.kind);
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId('engineer-A');
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  onlineManager.setOnline(false);
});

afterEach(async () => {
  cleanup();
  // Размонтирование — это момент записи (наряд пишет и при уходе с экрана),
  // а запись в IndexedDB асинхронная. Без паузы она приземляется уже ПОСЛЕ
  // очистки и всплывает в следующем тесте как чужая запись в очереди.
  await new Promise((r) => setTimeout(r, 0));
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
  setCurrentUserId(null);
  await clearAll();
});

describe('строка наряда на телефоне', () => {
  it('рисуется карточкой — таблицы, которую надо возить вбок, нет', async () => {
    const { container } = renderEditor('card');
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    expect(container.querySelector('table')).toBeNull();
  });

  it('у каждого поля своя подпись — в карточке заголовка колонки нет', async () => {
    renderEditor('card');
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    // Именно поля, а не просто текст на экране: подпись должна быть привязана
    // к вводу, иначе «31 пиксель без названия» превращается в «поле пошире,
    // но по-прежнему непонятно какое».
    expect(screen.getByLabelText('Наименование')).toBeTruthy();
    expect(screen.getByLabelText('Кол-во')).toBeTruthy();
    expect(screen.getByLabelText('Цена ₽')).toBeTruthy();
    expect(screen.getByLabelText('Ед.')).toBeTruthy();
    expect(screen.getByLabelText('Кто делал')).toBeTruthy();
  });

  it('десктоп остаётся таблицей', async () => {
    const { container } = renderEditor();
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    expect(container.querySelector('table')).not.toBeNull();
  });
});

describe('удаление строки наряда спрашивает', () => {
  it('по нажатию ничего не удаляется, пока человек не подтвердил', async () => {
    renderEditor('card');
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    fireEvent.click(screen.getByRole('button', { name: /Удалить строку/ }));

    expect(await screen.findByText(/Удалить строку наряда/)).toBeTruthy();
    expect(await queuedKinds()).toEqual([]);
  });

  it('отказался — строка на месте', async () => {
    renderEditor('card');
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    fireEvent.click(screen.getByRole('button', { name: /Удалить строку/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Отмена/ }));

    await waitFor(() => expect(screen.queryByText(/Удалить строку наряда/)).toBeNull());
    expect(await queuedKinds()).toEqual([]);
  });

  it('подтвердил — удаление уходит', async () => {
    renderEditor('card');
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    fireEvent.click(screen.getByRole('button', { name: /Удалить строку/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Удалить$/ }));

    await waitFor(async () => expect(await queuedKinds()).toEqual(['workOrders.deleteLine']));
  });
});

/**
 * Главный риск этой правки — сломать запись. Наряд пишет по уходу курсора из
 * поля, и на правиле «одна строка = одна запись» держится защита от дублей.
 */
describe('карточка пишет так же, как таблица', () => {
  it('поправил цену и ушёл из поля — правка уехала', async () => {
    renderEditor('card');
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    const price = screen.getByLabelText<HTMLInputElement>('Цена ₽');
    fireEvent.change(price, { target: { value: '18000' } });
    fireEvent.blur(price);

    await waitFor(async () => {
      const items = await listPending();
      expect(items).toHaveLength(1);
      expect(items[0]!.kind).toBe('workOrders.upsertLine');
      expect(JSON.stringify(items[0]!.payload)).toContain('18000');
    });
  });

  it('пустая цена по-прежнему не становится нулём', async () => {
    renderEditor('card');
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');
    // Чистим очередь прямо перед действием, а не только в beforeEach: уход с
    // экрана в предыдущем тесте — это тоже запись, и она приземляется в
    // IndexedDB с задержкой, уже после уборки. Так мы меряем ровно то, что
    // сделал ЭТОТ тест.
    await clearAll();

    const price = screen.getByLabelText<HTMLInputElement>('Цена ₽');
    fireEvent.change(price, { target: { value: '' } });
    fireEvent.blur(price);

    expect(await screen.findByText(/Цена не может быть пустой/)).toBeTruthy();
    expect(await queuedKinds()).toEqual([]);
  });
});
