/**
 * Пустое поле количества или цены НЕ становится нулём.
 *
 * НАХОДКА РАЗБОРА: инженер стирает число, чтобы набрать заново, отвлекается —
 * и строка уходит на сервер с нулём. Ни вопроса, ни подсветки: в наряде она
 * выглядит как обычная строка, глазами не отличить от честного нуля по
 * гарантии. Строка «Замена платы» на 18 000 ₽ превращалась в строку на 0 ₽:
 * клиенту выставили меньше, инженеру начислили меньше (сделка — процент от
 * строки), и никто об этом не узнал.
 *
 * В коде это было буквально `количество || '0'` и `цена || 0`.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (вариант A): пустое не сохраняем — возвращаем прежнее
 * число и говорим словами. Явно набранный «0» разрешён: бесплатно по гарантии
 * бывает, и мешать работать нельзя.
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

const TICKET = 'ffffffff-0000-4000-8000-00000000cccc';

/** Живая строка запчастей: 2 шт по 15 000 ₽. Именно её и обнуляли. */
const LINE = {
  id: 'line-1',
  lineType: 'part' as const,
  name: 'Замена платы питания',
  unit: 'шт',
  quantity: '2',
  unitPriceKopecks: '1500000',
  amountKopecks: '3000000',
  inventoryItemId: null,
  engineerId: null,
};

const WORK_ORDER = {
  id: 'wo-1',
  orderNumber: 'WO-1',
  ticketId: TICKET,
  vatRate: '20' as const,
  diagnosis: null,
  repairDescription: null,
  recommendation: null,
  worksAmountKopecks: '0',
  partsAmountKopecks: '3000000',
  expensesAmountKopecks: '0',
  vatAmountKopecks: '0',
  totalAmountKopecks: '3000000',
  lines: [LINE],
};

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
        // Связи нет — значит всё, что мы решим сохранить, ляжет в очередь и
        // будет видно вместе с числами.
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkOrderEditor ticketId={TICKET} ticketNumber="WSP-779" canEdit canEditVat={false} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

async function queuedText(): Promise<string> {
  const items = await listPending();
  return JSON.stringify(items.map((i) => i.payload));
}

/** Поля количества и цены — это `input type="number"`, они идут в таком порядке. */
async function numberInputs(): Promise<[HTMLInputElement, HTMLInputElement]> {
  const found = await screen.findAllByRole<HTMLInputElement>('spinbutton');
  return [found[0]!, found[1]!];
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId('engineer-A');
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  onlineManager.setOnline(false);
});

afterEach(async () => {
  cleanup();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
  setCurrentUserId(null);
  await clearAll();
});

describe('пустое количество не превращается в ноль', () => {
  it('стёр и ушёл из поля — на сервер не ушло ничего', async () => {
    renderEditor();
    const [quantity] = await numberInputs();

    fireEvent.change(quantity, { target: { value: '' } });
    fireEvent.blur(quantity);

    await new Promise((r) => setTimeout(r, 50));
    expect(await queuedText()).not.toContain('"quantity"');
  });

  it('и число возвращается в поле само', async () => {
    renderEditor();
    const [quantity] = await numberInputs();

    fireEvent.change(quantity, { target: { value: '' } });
    fireEvent.blur(quantity);

    await waitFor(() => expect(quantity.value).toBe('2'));
  });

  it('и человеку сказано словами, а не молча', async () => {
    renderEditor();
    const [quantity] = await numberInputs();

    fireEvent.change(quantity, { target: { value: '' } });
    fireEvent.blur(quantity);

    expect(await screen.findByText(/Количество не может быть пустым/)).toBeTruthy();
  });
});

describe('пустая цена не превращается в ноль', () => {
  it('стёр и ушёл из поля — прежняя цена на месте, на сервер не ушло ничего', async () => {
    renderEditor();
    const [, price] = await numberInputs();

    fireEvent.change(price, { target: { value: '' } });
    fireEvent.blur(price);

    await waitFor(() => expect(price.value).toBe('15000'));
    expect(await queuedText()).not.toContain('unitPriceRub');
    expect(await screen.findByText(/Цена не может быть пустой/)).toBeTruthy();
  });
});

describe('уход с экрана с пустым полем', () => {
  /**
   * Самый опасный случай: поле пустое, а экран уходит — сохранить ноль тут
   * было бы хуже всего, потому что инженер уже не увидит ни строки, ни подсказки.
   */
  it('ноль не уезжает на сервер вслед за инженером', async () => {
    const view = renderEditor();
    const [quantity] = await numberInputs();

    fireEvent.change(quantity, { target: { value: '' } });
    view.unmount();

    await new Promise((r) => setTimeout(r, 80));
    const queued = await queuedText();
    expect(queued).not.toContain('"quantity":"0"');
    expect(queued).not.toContain('"quantity":""');
  });
});

describe('осознанный ноль работать не мешает', () => {
  /**
   * Бесплатно по гарантии — обычное дело. Ноль, набранный руками, обязан
   * сохраняться: иначе правило превратится из защиты в помеху.
   */
  it('набранный «0» сохраняется как ноль', async () => {
    renderEditor();
    const [quantity] = await numberInputs();

    fireEvent.change(quantity, { target: { value: '0' } });
    fireEvent.blur(quantity);

    await waitFor(async () => expect(await queuedText()).toContain('"quantity":"0"'));
  });

  it('и цена «0» тоже', async () => {
    renderEditor();
    const [, price] = await numberInputs();

    fireEvent.change(price, { target: { value: '0' } });
    fireEvent.blur(price);

    await waitFor(async () => expect(await queuedText()).toContain('"unitPriceRub":0'));
  });
});
