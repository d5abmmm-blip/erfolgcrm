/**
 * Экран заявки инженера: чужую заявку СМОТРЕТЬ можно, МЕНЯТЬ нельзя.
 *
 * Решение владельца 2026-08-07: «смотреть всем, менять — только свои».
 * Свои = ответственный ИЛИ помощник; диспетчер и директор без ограничений.
 *
 * ЗАЧЕМ ЭТОТ ТЕСТ. Сам запрет стоит в двух местах: на сервере
 * (`assertEngineerMayEdit`, покрыт тестами api) и на экране — кнопки убраны,
 * сверху плашка. Экранную половину не проверял НИ ОДИН тест: проверялась
 * только функция-решалка `engineerOwnsTicket` отдельно от разметки. То есть
 * связь «правило → кнопки» могла тихо отвалиться при любой правке экрана,
 * и никто бы не узнал: деньги защитил бы сервер, а инженер получил бы
 * непонятный отказ вместо честной плашки.
 *
 * Поэтому здесь рендерится САМ экран, а не хелпер.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { MobileTicketPage } from '../pages/mobile/MobileTicketPage';

const TICKET_ID = 'ffffffff-0000-4000-8000-00000000dddd';
const ME = 'user-me';
const SOMEONE_ELSE = 'user-other';

interface Actor {
  id: string;
  role: 'engineer' | 'dispatcher' | 'director';
}

/** Заявка в работе — в этом статусе у инженера есть кнопка «Готов к акту». */
function ticketOf(assignedEngineerId: string | null, helperIds: string[] = []) {
  return {
    id: TICKET_ID,
    ticketNumber: 'WSP-9001',
    status: 'in_progress',
    receivedAt: new Date('2026-08-01T09:00:00Z'),
    scheduledStartAt: null,
    scheduledEndAt: null,
    clientDisplayName: 'ООО «Ромашка»',
    assetId: null,
    assetModel: 'Аппарат УЗИ',
    assetSerialNumber: 'SN-1',
    assetInventoryNumber: null,
    barcode: null,
    symptom: 'Не включается',
    repairType: null,
    assignedEngineerId,
    helperEngineers: helperIds.map((userId) => ({ userId, fullName: 'Помощник' })),
  };
}

/**
 * Сервер-заглушка на каждый запрос отдельно.
 *
 * Берём `httpLink`, а НЕ `httpBatchLink`: батч склеивает несколько процедур
 * в один запрос, и заглушке пришлось бы угадывать их порядок в ответе.
 */
function server(actor: Actor, ticket: ReturnType<typeof ticketOf>) {
  return (url: unknown): Promise<Response> => {
    const address = String(url);
    const answer = (payload: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify({ result: { data: { json: payload } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (address.includes('auth.me')) {
      return answer({ user: { id: actor.id, role: actor.role, fullName: 'Кто-то' } });
    }
    if (address.includes('tickets.get')) return answer(ticket);
    if (address.includes('tickets.events')) return answer([]);
    if (address.includes('workOrders.getByTicket')) return answer(null);
    if (address.includes('tickets.documentClient')) return answer(null);
    if (address.includes('attachments')) return answer([]);
    return answer(null);
  };
}

function renderTicketPage(actor: Actor, ticket: ReturnType<typeof ticketOf>) {
  // Экран берёт номер заявки из адреса — ставим адрес до отрисовки.
  window.history.pushState({}, '', `/m/tickets/${TICKET_ID}`);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: server(actor, ticket),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <MobileTicketPage />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

/** Ждём, пока заявка загрузится: до этого на экране «Загрузка…». */
async function ticketShown() {
  await screen.findByText('WSP-9001');
}

beforeEach(() => {
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  cleanup();
});

describe('чужая заявка у инженера', () => {
  it('открывается — смотреть не запрещено', async () => {
    renderTicketPage({ id: ME, role: 'engineer' }, ticketOf(SOMEONE_ELSE));
    await ticketShown();

    expect(screen.getByText('ООО «Ромашка»')).toBeTruthy();
  });

  it('сверху сказано, почему кнопок нет', async () => {
    renderTicketPage({ id: ME, role: 'engineer' }, ticketOf(SOMEONE_ELSE));
    await ticketShown();

    expect(screen.getByText('Это не ваша заявка')).toBeTruthy();
  });

  it('кнопки смены статуса нет', async () => {
    renderTicketPage({ id: ME, role: 'engineer' }, ticketOf(SOMEONE_ELSE));
    await ticketShown();

    expect(screen.queryByRole('button', { name: /Готов к акту/ })).toBeNull();
  });

  it('комментарий написать нельзя', async () => {
    renderTicketPage({ id: ME, role: 'engineer' }, ticketOf(SOMEONE_ELSE));
    await ticketShown();

    expect(screen.queryByRole('button', { name: /Сохранить комментарий/ })).toBeNull();
  });

  it('неназначенная заявка — тоже чужая', async () => {
    renderTicketPage({ id: ME, role: 'engineer' }, ticketOf(null));
    await ticketShown();

    expect(screen.getByText('Это не ваша заявка')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Готов к акту/ })).toBeNull();
  });
});

describe('своя заявка у инженера', () => {
  it('плашки нет, кнопки на месте', async () => {
    renderTicketPage({ id: ME, role: 'engineer' }, ticketOf(ME));
    await ticketShown();

    await waitFor(() => expect(screen.getByRole('button', { name: /Готов к акту/ })).toBeTruthy());
    expect(screen.queryByText('Это не ваша заявка')).toBeNull();
    expect(screen.getByRole('button', { name: /Сохранить комментарий/ })).toBeTruthy();
  });

  /**
   * Помощник выполняет ремонт наравне с ответственным (ticket_engineers,
   * мигр. 0080). Если экран забудет про помощников, они упрутся в «не ваша
   * заявка» на заявке, которую сами и делают.
   */
  it('помощник — тоже свой', async () => {
    renderTicketPage({ id: ME, role: 'engineer' }, ticketOf(SOMEONE_ELSE, ['x', ME]));
    await ticketShown();

    await waitFor(() => expect(screen.getByRole('button', { name: /Готов к акту/ })).toBeTruthy());
    expect(screen.queryByText('Это не ваша заявка')).toBeNull();
  });
});

describe('руководители не ограничены', () => {
  it('диспетчер правит любую заявку', async () => {
    renderTicketPage({ id: ME, role: 'dispatcher' }, ticketOf(SOMEONE_ELSE));
    await ticketShown();

    await waitFor(() => expect(screen.getByRole('button', { name: /Готов к акту/ })).toBeTruthy());
    expect(screen.queryByText('Это не ваша заявка')).toBeNull();
  });

  it('директор тоже', async () => {
    renderTicketPage({ id: ME, role: 'director' }, ticketOf(null));
    await ticketShown();

    await waitFor(() => expect(screen.getByRole('button', { name: /Готов к акту/ })).toBeTruthy());
    expect(screen.queryByText('Это не ваша заявка')).toBeNull();
  });
});
