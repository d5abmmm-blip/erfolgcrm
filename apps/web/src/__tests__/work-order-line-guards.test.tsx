/**
 * Сторожа строки наряда. Строка — самый денежный объект в системе: это и счёт
 * клиенту, и сделка в зарплате (процент от строки).
 *
 * ИСТОРИЯ ФАЙЛА. Он назывался «наряд карточками на телефоне» (#113) и проверял
 * телефонную раскладку строк: на 375 пикселях таблица из семи колонок ужимала
 * поле цены до 31 пикселя, а кнопка удаления была 14 × 14 вплотную к цене и
 * сносила строку без вопроса.
 *
 * ⚠️ ТЕЛЕФОННОЙ РАСКЛАДКИ БОЛЬШЕ НЕТ. Владелец 2026-08-08: «цена
 * устанавливается в десктопной CRM (менеджером/директором)», строки заводит
 * менеджер. У инженера на экране ни строк, ни денег — только «Что было и что
 * сделал» и «Списать со склада» (это проверяет engineer-writes-plainly).
 * Карточная разметка стала недостижимым кодом и удалена вместе с тестами.
 *
 * А ВОТ ДВА СТОРОЖА ОСТАЛИСЬ ЦЕННЫМИ — они не про раскладку, а про деньги, и
 * теперь стерегут десктоп:
 *   1. удаление строки СПРАШИВАЕТ и до ответа ничего не удаляет;
 *   2. пустая цена не превращается в ноль (иначе клиенту выставят меньше, а
 *      инженеру начислят меньше — и в наряде это будет выглядеть нормальной
 *      строкой).
 *
 * ПОЧЕМУ ПРОВЕРЯЕМ ЧЕРЕЗ ОЧЕРЕДЬ: связи нет, значит всё, что экран решит
 * записать, ляжет в оффлайн-очередь и будет видно вместе с числами.
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
  engineerNotes: null,
  worksAmountKopecks: '1250000',
  partsAmountKopecks: '0',
  expensesAmountKopecks: '0',
  vatAmountKopecks: '0',
  totalAmountKopecks: '1250000',
  lines: [LINE],
};

/** Десктоп менеджера — единственное место, где строки вообще правятся. */
function renderEditor() {
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
        <WorkOrderEditor ticketId={TICKET} ticketNumber="WSP-6472" canEdit canEditVat={false} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

async function queuedKinds(): Promise<string[]> {
  return (await listPending()).map((i) => i.kind);
}

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
  setCurrentUserId('manager-A');
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

describe('удаление строки наряда спрашивает', () => {
  it('по нажатию ничего не удаляется, пока человек не подтвердил', async () => {
    renderEditor();
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    fireEvent.click(screen.getByRole('button', { name: /Удалить строку/ }));

    expect(await screen.findByText(/Удалить строку наряда/)).toBeTruthy();
    expect(await queuedKinds()).toEqual([]);
  });

  it('отказался — строка на месте', async () => {
    renderEditor();
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    fireEvent.click(screen.getByRole('button', { name: /Удалить строку/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Отмена/ }));

    await waitFor(() => expect(screen.queryByText(/Удалить строку наряда/)).toBeNull());
    expect(await queuedKinds()).toEqual([]);
  });

  it('подтвердил — удаление уходит', async () => {
    renderEditor();
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    fireEvent.click(screen.getByRole('button', { name: /Удалить строку/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Удалить$/ }));

    await waitFor(async () => expect(await queuedKinds()).toEqual(['workOrders.deleteLine']));
  });
});

describe('деньги в строке не портятся молча', () => {
  it('поправил цену и ушёл из поля — правка уехала', async () => {
    renderEditor();
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');

    // Подписи полей заданы через aria-label: смысл несёт заголовок колонки, а
    // он с полем программно не связан — ни диктор, ни проверка его не видят.
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

  it('пустая цена не становится нулём', async () => {
    renderEditor();
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

  it('пустое количество тоже не становится нулём', async () => {
    renderEditor();
    await screen.findByDisplayValue('Замена блока питания рентген-аппарата');
    await clearAll();

    const qty = screen.getByLabelText<HTMLInputElement>('Кол-во');
    fireEvent.change(qty, { target: { value: '' } });
    fireEvent.blur(qty);

    expect(await screen.findByText(/Количество не может быть пустым/)).toBeTruthy();
    expect(await queuedKinds()).toEqual([]);
  });
});
