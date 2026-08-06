/**
 * «Приложение открывается без связи и показывает вчерашнюю правду».
 *
 * Два обещания, ради которых всё затевалось:
 *   1. холодный старт офлайн — очередь на экране, а не пустота;
 *   2. приложение честно говорит, НАСКОЛЬКО эти данные старые.
 *
 * Второе не менее важно первого: показать позавчерашний список как свежий —
 * хуже, чем не показать ничего.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MobileShell } from '../components/MobileShell';
import { MobileQueuePage } from '../pages/mobile/MobileQueuePage';
import {
  clearPersistedQueries,
  persistNow,
  restorePersistedQueries,
} from '../lib/offline/query-persist';
import { noteSync } from '../lib/offline/last-sync';

function trpcKey(path: string, input?: unknown): unknown[] {
  return [path.split('.'), { input, type: 'query' }];
}

function setOnline(value: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value });
  onlineManager.setOnline(value);
}

/** tRPC-клиент, у которого сеть не отвечает — как в подвале больницы. */
function offlineTrpcClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      }),
    ],
  });
}

const TICKET = {
  id: 'tk-1',
  ticketNumber: 'WSP-6472',
  status: 'in_progress' as const,
  priority: 'normal' as const,
  clientDisplayName: 'ГБУ «Городская больница №1»',
  assetModel: 'Аппарат ИВЛ Avea',
  assetSerialNumber: 'SN-77',
  assetInventoryNumber: null,
  deadlineAt: null,
  slaTargetAt: null,
};

beforeEach(async () => {
  await clearPersistedQueries();
  noteSync(null);
  localStorage.clear();
  setOnline(true);
});

afterEach(async () => {
  cleanup();
  setOnline(true);
  await clearPersistedQueries();
});

describe('холодный старт без связи', () => {
  it('очередь инженера видна из сохранённого кэша, хотя сеть молчит', async () => {
    // Вчера, со связью: приложение сохранило снимок кэша.
    const yesterday = new QueryClient();
    yesterday.setQueryData(
      // Ровно тот вход, с которым экран открывается по умолчанию (вкладка «Активные»).
      trpcKey('tickets.myList', {
        statuses: ['received', 'diagnostics', 'in_progress', 'act_pending'],
        pageSize: 50,
      }),
      { items: [TICKET], total: 1 },
    );
    await persistNow(yesterday);

    // Сегодня, в подвале: приложение запустилось заново, сети нет.
    setOnline(false);
    const fresh = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await restorePersistedQueries(fresh);

    render(
      <trpc.Provider client={offlineTrpcClient()} queryClient={fresh}>
        <QueryClientProvider client={fresh}>
          <MobileQueuePage engineerId="eng-1" />
        </QueryClientProvider>
      </trpc.Provider>,
    );

    expect(await screen.findByText('WSP-6472')).toBeTruthy();
    expect(screen.queryByText('Не удалось загрузить очередь заявок')).toBeNull();
  });
});

describe('возраст данных виден', () => {
  function session() {
    return {
      user: { id: 'u1', username: 'engineer', fullName: 'Ислаев Умар', role: 'engineer' as const },
      tenant: { id: 't1', subdomain: 'erfolg', displayName: 'ООО «Эрфольг»', disabledModules: [] },
    };
  }

  function renderShell() {
    const qc = new QueryClient();
    return render(
      <QueryClientProvider client={qc}>
        <MobileShell session={session()}>
          <div>содержимое</div>
        </MobileShell>
      </QueryClientProvider>,
    );
  }

  it('без связи пишет, от какого времени данные', async () => {
    const at = new Date();
    at.setHours(14, 32, 0, 0);
    noteSync(at.getTime());
    setOnline(false);

    renderShell();

    expect(await screen.findByText(/данные от 14:32/)).toBeTruthy();
  });

  it('со связью полоса не мешается', async () => {
    noteSync(Date.now());
    setOnline(true);

    renderShell();
    await screen.findByText('Очередь');

    expect(screen.queryByText(/данные от/)).toBeNull();
  });
});
