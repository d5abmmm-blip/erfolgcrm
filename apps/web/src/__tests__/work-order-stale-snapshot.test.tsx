/**
 * Правка шапки наряда несёт снимок «что человек видел» (досмотр №42).
 *
 * Без снимка реплей офлайн-очереди молча затирал более позднюю правку:
 * сервер не мог отличить «правлю то, что вижу» от «доношу давно устаревшее».
 * Теперь рядом с патчем едет base — значение поля, каким его показывал экран;
 * сервер отклоняет правку CONFLICT'ом, если поле уже изменили позже.
 *
 * Здесь проверяем клиентскую половину: payload мутации действительно содержит
 * base со значением из кэша экрана, и в офлайн-очередь он ложится тем же
 * payload'ом (реплей донесёт снимок без дополнительного кода).
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
  id: 'wo-2',
  orderNumber: 'WO-2',
  ticketId: TICKET,
  vatRate: '20' as const,
  diagnosis: 'старый диагноз',
  repairDescription: null,
  recommendation: null,
  worksAmountKopecks: '0',
  partsAmountKopecks: '0',
  expensesAmountKopecks: '0',
  vatAmountKopecks: '0',
  totalAmountKopecks: '0',
  lines: [],
};

/** POST-тела уходящих запросов — по ним видно, что именно шлёт экран. */
const captured: string[] = [];

function serverCapture() {
  return (url: unknown, init?: { method?: string; body?: unknown }): Promise<Response> => {
    const address = String(url);
    const isWrite = (init?.method ?? 'GET').toUpperCase() === 'POST';
    if (isWrite) captured.push(String(init?.body ?? ''));
    const payload = isWrite ? { ok: true } : address.includes('getByTicket') ? WORK_ORDER : [];
    return Promise.resolve(
      new Response(JSON.stringify([{ result: { data: { json: payload } } }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

function renderEditor(fetchImpl: (url: unknown, init?: { method?: string }) => Promise<Response>) {
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
        fetch: fetchImpl,
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

beforeEach(async () => {
  captured.length = 0;
  await clearAll();
  setCurrentUserId('engineer-A');
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
});

afterEach(async () => {
  cleanup();
  setCurrentUserId(null);
  await clearAll();
});

type HeaderCall = {
  ticketId: string;
  patch: { diagnosis?: string | null };
  base?: { diagnosis?: string | null };
};

describe('снимок «что видел человек» едет вместе с правкой', () => {
  it('онлайн: patch несёт новый текст, base — тот, что показывал экран', async () => {
    renderEditor(serverCapture());
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    // Первое поле шапки — «Диагноз», в нём текст из кэша экрана.
    expect(field.value).toBe('старый диагноз');

    fireEvent.change(field, { target: { value: 'новый диагноз' } });
    fireEvent.blur(field);

    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const body = JSON.parse(captured[0]!) as Record<string, { json: HeaderCall }>;
    const call = body['0']!.json;
    expect(call.patch.diagnosis).toBe('новый диагноз');
    expect(call.base?.diagnosis).toBe('старый диагноз');
  });

  it('офлайн: снимок ложится в очередь вместе с правкой — реплей его донесёт', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
    onlineManager.setOnline(false);
    renderEditor(() => Promise.reject(new TypeError('Failed to fetch')));
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    expect(field.value).toBe('старый диагноз');

    fireEvent.change(field, { target: { value: 'написано в подвале' } });
    fireEvent.blur(field);

    await waitFor(async () => expect((await listPending()).length).toBe(1));
    const [item] = await listPending();
    const payload = item!.payload as HeaderCall;
    expect(payload.patch.diagnosis).toBe('написано в подвале');
    expect(payload.base?.diagnosis).toBe('старый диагноз');
  });
});
