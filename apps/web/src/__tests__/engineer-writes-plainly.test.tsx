/**
 * Инженер пишет своими словами — экран.
 *
 * ЗАЧЕМ. Владелец 2026-08-08: «инженеры вообще не любят мобильное приложение,
 * надо минимизировать их контакт с программой. Они по-своему, по-колхозному
 * пишут, что сломалось и что сделали, а ИИ грамотно перефразирует». Решение
 * владельца — ОДНО поле вместо трёх.
 *
 * ЧТО БЫЛО. Три поля («Диагноз», «Описание ремонта», «Рекомендации») плюс
 * кнопка «ИИ-черновик», которая делала НЕ ТО: собирала текст из СТРОК наряда
 * и затирала поле, а написанное инженером не читала вовсе. Инженер, набравший
 * своё описание и нажавший кнопку, терял его целиком.
 *
 * ГЛАВНОЕ ЗДЕСЬ — четвёртый тест: «Оформить» не имеет права трогать текст
 * инженера. Это единственный экземпляр написанного человеком; всё остальное
 * из него выводится.
 *
 * Проверяем через ОЧЕРЕДЬ, как и соседние тесты наряда: связи нет, значит
 * запись обязана лечь в оффлайн-очередь — и видно САМ ТЕКСТ, а не только факт
 * отправки.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { WorkOrderEditor, type WorkOrderLayout } from '../components/WorkOrderEditor';
import { clearAll, listPending } from '../lib/offline/queue';
import { setCurrentUserId } from '../lib/offline/current-user';

const TICKET = 'ffffffff-0000-4000-8000-0000000000ee';

const WORK_ORDER = {
  id: 'wo-1',
  orderNumber: 'WO-1',
  ticketId: TICKET,
  vatRate: '20' as const,
  diagnosis: null,
  repairDescription: null,
  recommendation: null,
  engineerNotes: null,
  worksAmountKopecks: '0',
  partsAmountKopecks: '0',
  expensesAmountKopecks: '0',
  vatAmountKopecks: '0',
  totalAmountKopecks: '0',
  lines: [],
};

const COMPOSED = {
  diagnosis: 'Вышла из строя плата питания.',
  repairDescription: 'Плата питания заменена, работоспособность проверена.',
  aiUsed: true,
};

/**
 * Заглушка сервера.
 *
 * ⚠️ ОТВЕЧАЕМ ПО КАЖДОЙ ПРОЦЕДУРЕ ОТДЕЛЬНО, а не «на всё одно и то же».
 * `httpBatchLink` склеивает одновременные вызовы в ОДИН запрос: сохранение
 * исходника и оформление уезжают вместе, адресом
 * `…/workOrders.updateHeader,workOrders.composeFromNotes`. Заглушка, отдающая
 * один результат на такой запрос, роняет ОБА вызова — и тест показывает
 * «нет связи с сервером» там, где на самом деле всё работает.
 *
 * Настоящий офлайн честно падает: на этом падении держится вся очередь.
 * Заглушка, отвечающая 200 всегда, проверяла бы не то приложение.
 */
function serverComposesButCannotSave() {
  return (url: unknown): Promise<Response> => {
    if (!navigator.onLine) return Promise.reject(new TypeError('Failed to fetch'));
    const path = String(url).split('/trpc/')[1]?.split('?')[0] ?? '';
    const body = path.split(',').map((proc) => {
      if (proc.includes('composeFromNotes')) return { result: { data: { json: COMPOSED } } };
      if (proc.includes('getByTicket')) return { result: { data: { json: WORK_ORDER } } };
      return { result: { data: { json: null } } };
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

function renderEditor(
  layout: WorkOrderLayout,
  fetchImpl?: (url: unknown) => Promise<Response>,
) {
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
        <WorkOrderEditor
          ticketId={TICKET}
          ticketNumber="WSP-901"
          canEdit
          canEditVat={false}
          layout={layout}
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

async function queuedText(): Promise<string> {
  const items = await listPending();
  return JSON.stringify(items.map((i) => ({ kind: i.kind, payload: i.payload })));
}

/** Связь есть: заглушка сама решает, что ответить. */
function goOnline(): void {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
}

/** Настоящий офлайн — и подмена `navigator.onLine`, и событие. */
function goOffline(): void {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  onlineManager.setOnline(false);
  window.dispatchEvent(new Event('offline'));
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId('engineer-A');
  goOffline();
});

afterEach(async () => {
  cleanup();
  goOnline();
  setCurrentUserId(null);
  await clearAll();
});

describe('на телефоне у инженера одно поле, а не три', () => {
  it('есть «Что было и что сделал», нет «Диагноз»/«Описание ремонта»/«Рекомендации»', async () => {
    renderEditor('card');
    await screen.findByText(/Что было и что сделал/i);

    // jest-dom не подключён — матчер toBeInTheDocument здесь не работает.
    expect(screen.queryByText('Диагноз')).toBeNull();
    expect(screen.queryByText('Описание ремонта')).toBeNull();
    expect(screen.queryByText('Рекомендации')).toBeNull();
  });

  it('на десктопе всё как было — диспетчер правит три поля', async () => {
    renderEditor('table');
    await screen.findByText('Диагноз');
    expect(screen.queryByText('Описание ремонта')).not.toBeNull();
    expect(screen.queryByText('Рекомендации')).not.toBeNull();
    expect(screen.queryByText(/Что было и что сделал/i)).toBeNull();
  });
});

describe('набранное сохраняется само', () => {
  it('ушёл с экрана, не выходя из поля — текст инженера уже в очереди', async () => {
    const view = renderEditor('card');
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;

    fireEvent.change(field, { target: { value: 'плата сгорела поменял всё пашет' } });
    view.unmount();

    await waitFor(async () => {
      const queued = await queuedText();
      expect(queued).toContain('плата сгорела поменял всё пашет');
      // Исходник ложится в СВОЁ поле, а не в поля акта.
      expect(queued).toContain('engineerNotes');
    });
  });
});

describe('«Оформить» — предложение, а не подмена', () => {
  it('текст инженера остаётся на месте, предложенное показано отдельно', async () => {
    goOnline();
    renderEditor('card', serverComposesButCannotSave());
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'плата сгорела поменял всё пашет' } });

    fireEvent.click(await screen.findByRole('button', { name: /Оформить/ }));

    await screen.findByDisplayValue('Вышла из строя плата питания.');
    await screen.findByDisplayValue('Плата питания заменена, работоспособность проверена.');
    // ⚠️ Ровно этого не делала старая кнопка «ИИ-черновик»: она затирала поле.
    expect(field.value).toBe('плата сгорела поменял всё пашет');
  });

  it('«Применить» пишет оба поля акта, и только по нажатию', async () => {
    goOnline();
    renderEditor('card', serverComposesButCannotSave());
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'плата сгорела поменял всё пашет' } });
    fireEvent.click(await screen.findByRole('button', { name: /Оформить/ }));
    await screen.findByDisplayValue('Вышла из строя плата питания.');

    // Пока не нажали — в акт ничего не ушло.
    expect(await queuedText()).not.toContain('Вышла из строя плата питания');

    goOffline();
    fireEvent.click(await screen.findByRole('button', { name: /Применить/ }));

    await waitFor(async () => {
      const queued = await queuedText();
      expect(queued).toContain('Вышла из строя плата питания');
      expect(queued).toContain('Плата питания заменена');
    });
  });
});

/**
 * Без связи запрос не падает, а ВИСИТ на паузе — так намертво зависал сканер
 * (#112). Поэтому в сеть без связи не ходим вовсе и говорим об этом словами.
 */
describe('без связи оформить нельзя — и об этом сказано', () => {
  it('в сеть не идём, набранное всё равно записано', async () => {
    // Считаем ТОЛЬКО оформление. Сохранение исходника в сеть уходит и честно
    // падает — на этом падении и держится вся очередь (см. query-defaults).
    let composeCalls = 0;
    const countingFetch = (url: unknown): Promise<Response> => {
      if (String(url).includes('composeFromNotes')) composeCalls += 1;
      return serverComposesButCannotSave()(url);
    };
    renderEditor('card', countingFetch);
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'не греет' } });

    fireEvent.click(await screen.findByRole('button', { name: /Оформить/ }));

    await screen.findByText(/появится связь|появится сеть/i);
    expect(composeCalls).toBe(0);

    // Главное обещание: текст человека не потерян, он просто ждёт сети.
    await waitFor(async () => {
      expect(await queuedText()).toContain('не греет');
    });
  });
});
