/**
 * Инженер отвечает прямо из списка, не открывая заявку.
 *
 * ЗАПРОС ВЛАДЕЛЬЦА 2026-08-08: «инженеры вообще не любят мобильное приложение,
 * надо минимизировать их контакт с программой — они видят, что им назначили,
 * и реагируют: в ремонте / сделал / жду запчасть».
 *
 * ЧТО БЫЛО (проверено по коду):
 *   · «Взял в работу» не существовало вовсе. Свежая заявка в статусе «Принята»,
 *     и чтобы сдвинуть её, надо было открыть карточку, нажать «Начать
 *     диагностику», потом «В работу», потом уйти назад — четыре тапа и два
 *     экрана НА КАЖДУЮ заявку.
 *   · «Жду запчасть» инженеру было недоступно, пока заявка не пожелтеет от
 *     простоя: кнопка показывалась только в блоке «Провисло» (там условие
 *     `light !== 'green'`), а `setWaitingForPart`/`setBlockedReason` — вообще
 *     staffProcedure, инженеру закрыты. То есть самый частый ответ в медтехнике
 *     нельзя было дать в день выезда — только через несколько дней простоя.
 *
 * Сервер тут был ни при чём: `engineerReact` с `part` принимал свежую заявку
 * всегда (сторож на это есть в api-тестах). Мешал только экран.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { MobileQueuePage } from '../pages/mobile/MobileQueuePage';
import { clearAll, listPending } from '../lib/offline/queue';
import { setCurrentUserId } from '../lib/offline/current-user';

const ME = 'engineer-me';

function ticket(id: string, ticketNumber: string, status: string) {
  return {
    id,
    ticketNumber,
    status,
    priority: 'normal',
    repairType: 'repair',
    clientId: 'c1',
    clientDisplayName: 'ГБУ «Больница №1»',
    assetId: 'a1',
    assetModel: 'Рентген РДК',
    assetSerialNumber: 'SN-1',
    assetInventoryNumber: null,
    barcode: `T${id}`,
    assignedEngineerId: ME,
    assignedEngineerName: 'Я',
    slaTargetAt: null,
    deadlineAt: null,
    receivedAt: new Date('2026-08-01T09:00:00Z'),
    createdAt: new Date('2026-08-01T09:00:00Z'),
    waitingForPart: false,
    idleDays: 0,
  };
}

/** Сервер-заглушка: различаем по адресу, иначе экран падает на чужой форме. */
function server(items: ReturnType<typeof ticket>[]) {
  return (url: unknown): Promise<Response> => {
    // Настоящий офлайн: запрос уходит (мутации у нас networkMode:'always') и
    // ЧЕСТНО падает — на этом падении и держится вся офлайн-очередь. Заглушка,
    // отвечающая 200 всегда, проверяла бы не то приложение.
    if (!navigator.onLine) return Promise.reject(new TypeError('Failed to fetch'));
    const address = String(url);
    const answer = (payload: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify({ result: { data: { json: payload } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (address.includes('tickets.myList')) return answer({ items, total: items.length });
    // «Мой день» и расписание экрану нужны, но для этих проверок пусты:
    // блок «Провисло» строится из myTickets, а мы смотрим общий список.
    if (address.includes('tickets.myTickets')) return answer([]);
    if (address.includes('myWeeklySchedule')) return answer([]);
    return answer(null);
  };
}

function renderQueue(items: ReturnType<typeof ticket>[]) {
  window.history.pushState({}, '', '/m/queue');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: server(items),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <MobileQueuePage engineerId={ME} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

/** Заявка «моего дня» — из неё строится блок «Провисло». */
function stuckTicket(overrides: Record<string, unknown> = {}) {
  return {
    ...ticket('s1', 'T-2026-000025', 'in_progress'),
    assetModel: 'УЗИ DC-40 EXP',
    effectiveReason: null,
    light: 'yellow',
    stuckDays: 3,
    idleDays: 3,
    askSnoozed: false,
    ...overrides,
  };
}

/** Заглушка, где «Мой день» НЕ пуст: смотрим именно блок «Провисло». */
function serverWithMyDay(mine: ReturnType<typeof stuckTicket>[]) {
  return (url: unknown): Promise<Response> => {
    if (!navigator.onLine) return Promise.reject(new TypeError('Failed to fetch'));
    const address = String(url);
    const answer = (payload: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify({ result: { data: { json: payload } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (address.includes('tickets.myTickets')) return answer(mine);
    if (address.includes('tickets.myList')) return answer({ items: [], total: 0 });
    if (address.includes('myWeeklySchedule')) return answer([]);
    // ⚠️ Отвечаем КАК НАСТОЯЩИЙ сервер. Пока здесь был `null`, экран падал на
    // `result.data.message` необработанным отклонением — и тест был зелёным,
    // потому что падение случалось вне его. Заглушка, которая врёт, проверяет
    // не то приложение.
    if (address.includes('engineerReact')) {
      return answer({ kind: 'inwork', ticketNumber: 'T-2026-000025', message: 'Принято.' });
    }
    return answer(null);
  };
}

function renderWithMyDay(mine: ReturnType<typeof stuckTicket>[]) {
  window.history.pushState({}, '', '/m/queue');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: serverWithMyDay(mine),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <MobileQueuePage engineerId={ME} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId(ME);
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
  setCurrentUserId(null);
  await clearAll();
});

describe('кнопки ответа стоят прямо в строке списка', () => {
  it('свежая заявка «Принята» — предлагает взять в работу', async () => {
    renderQueue([ticket('t1', 'WSP-6472', 'received')]);
    await screen.findByText('WSP-6472');

    expect(screen.getByRole('button', { name: /Взял в работу/ })).toBeTruthy();
    // Отмечать «готово» по заявке, к которой не приступали, нечего —
    // сервер такой переход и не пропустит.
    expect(screen.queryByRole('button', { name: /^Готово$/ })).toBeNull();
  });

  it('заявка в работе — предлагает «Готово» и «Жду запчасть»', async () => {
    renderQueue([ticket('t2', 'WSP-6480', 'in_progress')]);
    await screen.findByText('WSP-6480');

    expect(screen.getByRole('button', { name: /Готово/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Жду запчасть/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Взял в работу/ })).toBeNull();
  });

  it('«Жду запчасть» доступно сразу, а не после нескольких дней простоя', async () => {
    // Заявка свежая и «зелёная» — раньше кнопки не было нигде на экране.
    renderQueue([ticket('t3', 'WSP-6481', 'diagnostics')]);
    await screen.findByText('WSP-6481');

    expect(screen.getByRole('button', { name: /Жду запчасть/ })).toBeTruthy();
  });

  it('готовую к выдаче больше ни о чём не спрашиваем', async () => {
    renderQueue([ticket('t4', 'WSP-6482', 'act_pending')]);
    await screen.findByText('WSP-6482');

    expect(screen.queryByRole('button', { name: /Взял в работу/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Жду запчасть/ })).toBeNull();
  });
});

describe('ответ из списка переживает отсутствие связи', () => {
  it('без связи «Взял в работу» ложится в очередь и уходит потом', async () => {
    renderQueue([ticket('t5', 'WSP-6610', 'received')]);
    await screen.findByText('WSP-6610');

    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
    onlineManager.setOnline(false);

    fireEvent.click(screen.getByRole('button', { name: /Взял в работу/ }));

    await waitFor(async () => {
      const items = await listPending();
      expect(items).toHaveLength(1);
      expect(items[0]!.kind).toBe('tickets.engineerReact');
      expect(items[0]!.payload).toMatchObject({ ticketId: 't5', action: 'start' });
    });
  });
});

/**
 * ⚠️ ЖАЛОБА С БОЯ (фото телефона инженера, 2026-08-08): «инженер нажимает, что
 * аппарат в работе, а плашка всё равно выходит при каждом входе».
 *
 * Так и было. Сервер на «Ещё в работе» ставит отметку «молчать 2 дня» и
 * отвечает человеку «пару дней не беспокою» — бот замолкает. А этот блок
 * считался БЕЗ отметки: карточка пряталась только в памяти страницы
 * (`useState`), и любой перезаход возвращал её. Программа обещала одно, а
 * делала другое — ровно тому человеку, которого просили «поменьше трогать
 * программу».
 */
describe('«Провисло» уважает уже данный ответ', () => {
  it('ответил «ещё в работе» — при следующем входе не спрашиваем снова', async () => {
    renderWithMyDay([stuckTicket({ askSnoozed: true })]);
    await screen.findByText('Активные');
    // Плашки нет — но убедимся, что дело не в «данные не доехали»: тот же
    // экран с тем же нарядом БЕЗ отметки её показывает (следующий тест).
    await waitFor(() => expect(screen.queryByText(/Загрузка|Загружаем/)).toBeNull());

    expect(screen.queryByText(/Провисло/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Ещё в работе/ })).toBeNull();
  });

  it('ответа не было — спрашиваем, иначе заявка потеряется молча', async () => {
    renderWithMyDay([stuckTicket()]);
    await screen.findByText(/Провисло/);

    expect(screen.getByText('T-2026-000025')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ещё в работе/ })).toBeTruthy();
  });

  it('нажал прямо сейчас — карточка уходит сразу, не дожидаясь перечитывания', async () => {
    renderWithMyDay([stuckTicket()]);
    await screen.findByText(/Провисло/);

    fireEvent.click(screen.getByRole('button', { name: /Ещё в работе/ }));

    await waitFor(() => expect(screen.queryByText(/Провисло/)).toBeNull());
  });
});
