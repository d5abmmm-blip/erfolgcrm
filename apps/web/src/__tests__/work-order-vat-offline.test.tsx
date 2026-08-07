/**
 * Ставка НДС переживает пропажу связи.
 *
 * НАХОДКА РАЗБОРА: `setVatRate` — единственная правка наряда, которая шла мимо
 * офлайн-очереди. Без связи она просто не проходила: поле отскакивало на
 * прежнее значение, человек видел «Нет связи с сервером. Изменение не
 * сохранено» и должен был вернуться и повторить сам. Все соседние правки
 * (диагноз, строки, комментарий) в этот момент спокойно ложились в очередь.
 *
 * Инженера это не касается — поле у него выключено. Касается диспетчера и
 * директора, а ставка НДС идёт прямо в счёт клиенту: у нас льготные 5 % на
 * медтехнику, и ошибка видна в документе.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { WorkOrderEditor } from '../components/WorkOrderEditor';
import { AppToaster } from '../components/AppToaster';
import { clearAll, listPending } from '../lib/offline/queue';
import { setCurrentUserId } from '../lib/offline/current-user';
import { describeOutboxItem } from '../lib/offline/describe-outbox';

const TICKET = 'ffffffff-0000-4000-8000-00000000eeee';

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

/** Диспетчер или директор: у инженера это поле выключено. */
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
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/* Сообщения показывает отдельный компонент — без него тосту негде появиться. */}
        <AppToaster />
        <WorkOrderEditor ticketId={TICKET} ticketNumber="WSP-780" canEdit canEditVat />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId('dispatcher-A');
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

describe('ставка НДС без связи', () => {
  /**
   * Сообщение проверяем ЗДЕСЬ, в первом тесте файла, а не отдельным: шина
   * тостов склеивает одинаковые сообщения за 3 секунды (иначе человек получал
   * три одинаковых подряд). В следующих тестах тот же текст будет проглочен —
   * и отдельный тест на него врал бы через раз.
   */
  it('ложится в очередь, и человеку сказано, что она ждёт связи', async () => {
    renderEditor();
    const select = await screen.findByRole('combobox');

    fireEvent.change(select, { target: { value: '5' } });

    await waitFor(async () => {
      const queued = await listPending();
      expect(queued.some((i) => i.kind === 'workOrders.setVatRate')).toBe(true);
    });
    expect(await screen.findByText(/сохранено в очередь/)).toBeTruthy();
  });

  it('в очередь попадает ИМЕННО выбранная ставка', async () => {
    renderEditor();
    const select = await screen.findByRole('combobox');

    fireEvent.change(select, { target: { value: '5' } });

    await waitFor(async () => {
      const queued = await listPending();
      const vat = queued.find((i) => i.kind === 'workOrders.setVatRate');
      expect(JSON.stringify(vat?.payload)).toContain('"vatRate":"5"');
    });
  });

  /**
   * Ставка у наряда одна. Передумал трижды — на сервер обязана уехать одна
   * запись с последним выбором, иначе очередь будет гонять промежуточные.
   */
  it('передумал несколько раз — в очереди одна запись, последняя', async () => {
    renderEditor();
    const select = await screen.findByRole('combobox');

    fireEvent.change(select, { target: { value: '5' } });
    fireEvent.change(select, { target: { value: '10' } });
    fireEvent.change(select, { target: { value: '0' } });

    await waitFor(async () => {
      const vat = (await listPending()).filter((i) => i.kind === 'workOrders.setVatRate');
      expect(vat).toHaveLength(1);
      expect(JSON.stringify(vat[0]?.payload)).toContain('"vatRate":"0"');
    });
  });
});

describe('в списке «Не отправлено» ставка названа по-человечески', () => {
  /**
   * Записи очереди человек видит в профиле. Без подписи он увидел бы
   * «Изменение» без единой подробности — и не понял бы, что именно ждёт связи.
   */
  it('видно, что это ставка НДС и какая именно', () => {
    const d = describeOutboxItem({
      kind: 'workOrders.setVatRate',
      payload: { ticketId: TICKET, vatRate: '5' },
      label: 'WSP-780',
    });
    expect(d.title).toBe('Ставка НДС в наряде WSP-780');
    expect(d.detail).toBe('5%');
  });

  it('«без НДС» так и написано, а не «without_vat»', () => {
    const d = describeOutboxItem({
      kind: 'workOrders.setVatRate',
      payload: { ticketId: TICKET, vatRate: 'without_vat' },
    });
    expect(d.detail).toBe('без НДС');
  });
});

describe('экран показывает то, что выбрал человек', () => {
  /**
   * Найдено живой проверкой: правка ложилась в очередь, а поле возвращалось к
   * прежней ставке — оно управляется данными с сервера, а сервера сейчас нет.
   * Диспетчер выбирал 5 %, видел снова 20 % и решал, что не сохранилось.
   */
  it('выбранная ставка остаётся в поле, пока ждёт связи', async () => {
    renderEditor();
    const select = await screen.findByRole<HTMLSelectElement>('combobox');

    fireEvent.change(select, { target: { value: '5' } });

    await waitFor(() => expect(select.value).toBe('5'));
  });

  it('и рядом сказано, что она ждёт связи', async () => {
    renderEditor();
    const select = await screen.findByRole('combobox');

    fireEvent.change(select, { target: { value: '10' } });

    expect(await screen.findByText(/ждёт связи/)).toBeTruthy();
  });
});
