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
  // Типы указаны явно: без них TS выводит литеральный `null`, и наряд с
  // заполненным диагнозом уже не собрать через orderOverride.
  diagnosis: null as string | null,
  repairDescription: null as string | null,
  recommendation: null as string | null,
  engineerNotes: null as string | null,
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

interface FakeServer {
  fetch: (url: unknown, init?: RequestInit) => Promise<Response>;
  /** Наряд, каким его знает «сервер». Правится через updateHeader. */
  order: typeof WORK_ORDER;
  /** Что сервер ПРИНЯЛ. По нему судим о записи, а не по очереди. */
  writes: Array<Record<string, unknown>>;
  composeCalls: number;
  draftCalls: number;
  /** Что отдаёт «ИИ-черновик». Пусто = собирать не из чего. */
  draftText: string;
}

/**
 * Заглушка сервера, которая НЕ ВРЁТ.
 *
 * ⚠️ ТРИ ПРАВИЛА, каждое куплено ложным результатом.
 *
 * 1. ОТВЕЧАЕМ ПО КАЖДОЙ ПРОЦЕДУРЕ ОТДЕЛЬНО. `httpBatchLink` склеивает
 *    одновременные вызовы в ОДИН запрос по адресу
 *    `…/workOrders.updateHeader,workOrders.composeFromNotes`. Заглушка,
 *    отдающая один результат на такой запрос, роняет ОБА вызова — и тест
 *    показывает «нет связи с сервером» там, где всё работает.
 * 2. ЗАПИСЬ РЕАЛЬНО МЕНЯЕТ НАРЯД, и перечитывание отдаёт НОВОЕ значение. Пока
 *    заглушка отдавала исходный наряд, «сохранено» проверялось по ложной
 *    причине, а заполненные поля акта после первого же refetch исчезали.
 * 3. ПРИНЯТОЕ СЕРВЕРОМ ВИДНО В `writes`. Проверять запись только по
 *    офлайн-очереди нельзя: онлайн очередь пуста ВСЕГДА, и assert вида
 *    «в очереди нет этого текста» не может упасть — он зелёный и когда кнопка
 *    работает, и когда она сломана. Ровно так и было (найдено разбором).
 *
 * Настоящий офлайн честно падает — на этом падении держится вся очередь.
 */
function makeServer(overrides: Partial<typeof WORK_ORDER> = {}): FakeServer {
  const server: FakeServer = {
    order: { ...WORK_ORDER, ...overrides },
    writes: [],
    composeCalls: 0,
    draftCalls: 0,
    draftText: 'Выполнены работы: замена платы.',
    fetch: () => Promise.reject(new TypeError('not initialised')),
  };
  server.fetch = (url: unknown, init?: RequestInit): Promise<Response> => {
    if (!navigator.onLine) return Promise.reject(new TypeError('Failed to fetch'));
    const path = String(url).split('/trpc/')[1]?.split('?')[0] ?? '';
    let inputs: Record<string, { json?: Record<string, unknown> }> = {};
    try {
      inputs = init?.body ? (JSON.parse(String(init.body)) as typeof inputs) : {};
    } catch {
      inputs = {};
    }
    const body = path.split(',').map((proc, i) => {
      const input = inputs[String(i)]?.json ?? {};
      if (proc.includes('composeFromNotes')) {
        server.composeCalls += 1;
        return { result: { data: { json: COMPOSED } } };
      }
      // Десктопная кнопка «ИИ-черновик» (фича №13) — собирает из строк наряда.
      if (proc.includes('draftRepairDescription')) {
        server.draftCalls += 1;
        return { result: { data: { json: { text: server.draftText, aiUsed: false } } } };
      }
      if (proc.includes('updateHeader')) {
        const patch = (input.patch as Record<string, unknown>) ?? {};
        server.writes.push(patch);
        Object.assign(server.order, patch);
        return { result: { data: { json: null } } };
      }
      if (proc.includes('getByTicket')) {
        return { result: { data: { json: { ...server.order } } } };
      }
      return { result: { data: { json: null } } };
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return server;
}

function renderEditor(layout: WorkOrderLayout, server?: FakeServer, canEdit = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  queryClient.setQueryData(
    [['workOrders', 'getByTicket'], { input: { ticketId: TICKET }, type: 'query' }],
    server ? { ...server.order } : WORK_ORDER,
  );
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: server?.fetch ?? (() => Promise.reject(new TypeError('Failed to fetch'))),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkOrderEditor
          ticketId={TICKET}
          ticketNumber="WSP-901"
          canEdit={canEdit}
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

/** Текст поля инженера прямо из DOM — он неуправляемый, состояние не спросить. */
function notesBox(): HTMLTextAreaElement {
  return document.getElementById(`engineer-notes-${TICKET}`) as HTMLTextAreaElement;
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
  // ⚠️ Черновики полей живут в localStorage и переживают cleanup(). Без этой
  // строки текст из предыдущего теста подставлялся в поле следующего — и тест
  // «поле пустое» шёл по ветке «поле не пустое», молча проверяя не то.
  localStorage.clear();
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

/**
 * «Инженеры не любят приложение, надо минимизировать их контакт с программой»
 * — решение владельца 2026-08-08, и полей оно касается не только трёх.
 *
 * НДС инженеру не нужен и НЕ ЕГО ДЕЛО: ставку меняют директор и диспетчер,
 * у инженера селектор был заперт и подписан «меняет директор/диспетчер» —
 * то есть занимал место, ничего не давая. Суммы работ ему нужны (от них
 * считается сделка), а «ВСЕГО с НДС» — это счёт клиенту, не его забота.
 */
/**
 * ⚠️ РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-08-08: «цена устанавливается в десктопной CRM
 * (менеджером/директором)», строки наряда заводит менеджер.
 *
 * Почему это не просто «убрать лишние поля»:
 *  · себестоимость труда считается как ПРОЦЕНТ ИНЖЕНЕРА ОТ ЦЕНЫ СТРОКИ (#88,
 *    часов в базе нет) — значит, набирая цену, инженер назначал сам себе
 *    сделку. Нельзя ставить человека в положение, где одним числом он
 *    выставляет счёт больнице и премию себе;
 *  · запчасть, вписанная руками, имеет НУЛЕВУЮ себестоимость — система не
 *    знает, откуда она. Вся цена засчитывается как прибыль. Правильный путь
 *    один: «Списать со склада», там себестоимость приходит из партий закупки.
 *
 * Поэтому со склада списывать инженер по-прежнему должен (только он знает, что
 * физически взял), а денег на его экране нет вовсе.
 */
describe('строки и деньги — не дело инженера', () => {
  it('таблиц наряда на телефоне нет', async () => {
    renderEditor('card');
    await screen.findByText(/Что было и что сделал/i);

    expect(screen.queryByText('Работы')).toBeNull();
    expect(screen.queryByText('Прочие расходы')).toBeNull();
    expect(screen.queryByRole('button', { name: /Добавить строку/ })).toBeNull();
  });

  it('ни цен, ни итогов', async () => {
    renderEditor('card');
    await screen.findByText(/Что было и что сделал/i);

    expect(screen.queryByText(/Итого работы/i)).toBeNull();
    expect(screen.queryByText(/ВСЕГО/)).toBeNull();
    expect(screen.queryByPlaceholderText('Что выполнено')).toBeNull();
  });

  it('«Списать со склада» остаётся — это его дело, и только он знает, что взял', async () => {
    renderEditor('card');
    await screen.findByRole('button', { name: /Списать со склада/ });
  });

  it('что уже списано — видно, но без цены', async () => {
    renderEditor(
      'card',
      makeServer({
        lines: [
          {
            id: 'l1',
            lineType: 'part',
            name: 'Плата питания Mindray PSU-70',
            unit: 'шт',
            quantity: '1',
            unitPriceKopecks: '2850000',
            amountKopecks: '2850000',
            costPerUnitKopecks: '0',
            engineerId: null,
            engineerName: null,
            comment: null,
            inventoryItemId: 'inv-1',
            orderIdx: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ] as never,
      }),
    );

    await screen.findByText(/Плата питания Mindray PSU-70/);
    // 28 500 ₽ — не его забота и на экране быть не должно.
    expect(screen.queryByText(/28 500/)).toBeNull();
    expect(screen.queryByText(/₽/)).toBeNull();
  });

  it('на десктопе таблицы и итоги на месте — там работает менеджер', async () => {
    renderEditor('table');
    await screen.findByText('Работы');
    expect(screen.queryByText('Прочие расходы')).not.toBeNull();
    expect(screen.queryByText(/Итого работы/i)).not.toBeNull();
    expect(screen.queryAllByRole('button', { name: /Добавить строку/ }).length).toBeGreaterThan(0);
  });
});

describe('чужого на экране инженера нет', () => {
  it('ставки НДС у инженера нет вовсе', async () => {
    renderEditor('card');
    await screen.findByText(/Что было и что сделал/i);

    expect(screen.queryByText(/Ставка НДС/i)).toBeNull();
    expect(screen.queryByText(/меняет директор/i)).toBeNull();
  });

  /**
   * Сначала я оставил инженеру суммы работ — рассудив, что от них считается
   * его сделка. Владелец 2026-08-08 решил иначе: «цена устанавливается в
   * десктопной CRM (менеджером/директором)». Раз он цены не ставит, то и
   * видеть их незачем: чтобы починить аппарат, знать счёт больницы не нужно.
   */
  it('денег на экране инженера нет вовсе — ни строк, ни сумм', async () => {
    renderEditor('card');
    await screen.findByText(/Что было и что сделал/i);

    expect(screen.queryByText(/Итого работы/i)).toBeNull();
    expect(screen.queryByText(/ВСЕГО/)).toBeNull();
  });

  it('на десктопе НДС на месте — его правит диспетчер', async () => {
    renderEditor('table');
    await screen.findByText(/Ставка НДС/i);
    expect(screen.queryByText(/ВСЕГО \(с НДС/i)).not.toBeNull();
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

const RAW = 'плата сгорела поменял всё пашет';

/** Онлайн: набрать текст, нажать «Оформить», дождаться предложения. */
async function typeAndCompose(server: FakeServer, text = RAW) {
  goOnline();
  renderEditor('card', server);
  const field = await screen.findByLabelText(/Что было и что сделал/i);
  fireEvent.change(field, { target: { value: text } });
  fireEvent.click(await screen.findByRole('button', { name: /Оформить/ }));
  await screen.findByDisplayValue(COMPOSED.diagnosis);
  return field as HTMLTextAreaElement;
}

describe('«Оформить» — предложение, а не подмена', () => {
  it('текст инженера остаётся на месте, предложенное показано отдельно', async () => {
    const server = makeServer();
    const field = await typeAndCompose(server);

    await screen.findByDisplayValue(COMPOSED.repairDescription);
    // ⚠️ Ровно этого не делала старая кнопка «ИИ-черновик»: она затирала поле.
    expect(field.value).toBe(RAW);
  });

  /**
   * ⚠️ ГЛАВНОЕ ОБЕЩАНИЕ ФАЙЛА, и до разбора его НЕ ПРОВЕРЯЛ НИ ОДИН ТЕСТ:
   * смотрели на поле только ДО «Применить». Мутация «затирать текст инженера
   * после применения» проходила все тесты зелёной.
   */
  it('и ПОСЛЕ «Применить» текст инженера цел — и на экране, и на сервере', async () => {
    const server = makeServer();
    await typeAndCompose(server);

    fireEvent.click(await screen.findByRole('button', { name: /^Применить$/ }));
    await screen.findByText(/Записано в наряд/i);

    expect(notesBox().value).toBe(RAW);
    expect(server.order.engineerNotes).toBe(RAW);
  });

  it('«Применить» пишет оба поля акта, и только по нажатию', async () => {
    const server = makeServer();
    await typeAndCompose(server);

    // Пока не нажали — сервер полей акта не видел.
    expect(server.order.diagnosis).toBeNull();
    expect(server.order.repairDescription).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /^Применить$/ }));

    await waitFor(() => {
      expect(server.order.diagnosis).toBe(COMPOSED.diagnosis);
      expect(server.order.repairDescription).toBe(COMPOSED.repairDescription);
    });
  });

  /**
   * Две отдельные записи означали, что вторая может не дойти — и в наряде
   * останется новый диагноз со старым описанием ремонта. Оба поля правит одно
   * действие человека, значит и запись должна быть одна.
   */
  it('оба поля уходят ОДНОЙ записью, а не двумя', async () => {
    const server = makeServer();
    await typeAndCompose(server);
    server.writes.length = 0;

    fireEvent.click(await screen.findByRole('button', { name: /^Применить$/ }));
    await waitFor(() => expect(server.writes.length).toBeGreaterThan(0));

    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]).toMatchObject({
      diagnosis: COMPOSED.diagnosis,
      repairDescription: COMPOSED.repairDescription,
    });
  });

  it('без связи «Применить» кладёт обе правки в очередь одной записью', async () => {
    const server = makeServer();
    await typeAndCompose(server);
    goOffline();

    fireEvent.click(await screen.findByRole('button', { name: /^Применить$/ }));

    await waitFor(async () => {
      const queued = await queuedText();
      expect(queued).toContain(COMPOSED.diagnosis);
      expect(queued).toContain('Плата питания заменена');
    });
  });

  /**
   * Разбор нашёл только работу, про поломку молчок — а в наряде уже есть
   * диагноз, написанный диспетчером со слов клиента. Пустое поле предложения
   * не должно стирать чужой текст: это «мне нечего сказать», а не «сотри».
   */
  it('пустое поле предложения НЕ стирает то, что в наряде уже написано', async () => {
    const server = makeServer({ diagnosis: 'Пробой платы питания (написал диспетчер)' });
    await typeAndCompose(server);

    // Инженер стёр предложенный диагноз — сказать про поломку ему нечего.
    fireEvent.change(await screen.findByLabelText(/^Диагноз$/i), { target: { value: '' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Применить$/ }));

    // И вопроса нет: диагноз никто не переписывает, терять нечего.
    expect(screen.queryByRole('button', { name: /Заменить/ })).toBeNull();

    await waitFor(() => expect(server.order.repairDescription).toBe(COMPOSED.repairDescription));
    expect(server.order.diagnosis).toBe('Пробой платы питания (написал диспетчер)');
    expect(server.writes.some((w) => 'diagnosis' in w)).toBe(false);
  });

  /**
   * Инженер написал в единственное поле и ушёл, не нажав «Оформить». В акте
   * пусто, а он уверен, что всё заполнил. Раньше экран об этом молчал.
   */
  it('написано, но не оформлено — экран говорит, что в акт это не попадёт', async () => {
    const server = makeServer({ engineerNotes: RAW });
    goOnline();
    renderEditor('card', server);

    await screen.findByText(/не оформлено|не попад/i);
  });
});

/**
 * Рекомендация — это НЕ украшение наряда. Она печатается в трёх бланках, и в
 * дефектном акте становится заключением «рекомендовано к списанию»
 * (см. lib/pdf/defect-act.ts). Инженер печатает эти бланки прямо с телефона,
 * значит и заполнять их должен уметь оттуда же.
 *
 * Убрав с телефона три поля ради одного, я вместе с ними убрал и это —
 * инженер не мог ни вписать рекомендацию, ни увидеть уже написанную.
 */
describe('рекомендация доступна с телефона', () => {
  it('свёрнута, пока не нужна, — но открывается и сохраняется', async () => {
    const view = renderEditor('card');
    fireEvent.click(await screen.findByRole('button', { name: /рекомендаци/i }));

    const box = await screen.findByLabelText(/Рекомендации/i);
    fireEvent.change(box, { target: { value: 'Рекомендовано к списанию' } });
    view.unmount();

    await waitFor(async () => {
      const queued = await queuedText();
      expect(queued).toContain('Рекомендовано к списанию');
      expect(queued).toContain('recommendation');
    });
  });

  it('уже написанную видно сразу, разворачивать не надо', async () => {
    renderEditor(
      'card',
      makeServer({ recommendation: 'До замены эксплуатация не рекомендована.' }),
    );
    await screen.findByDisplayValue('До замены эксплуатация не рекомендована.');
  });

  it('по чужой заявке рекомендацию видно, но не изменить', async () => {
    renderEditor('card', makeServer({ recommendation: 'Рекомендовано к списанию' }), false);
    const box = await screen.findByDisplayValue('Рекомендовано к списанию');
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
  });

  /**
   * Рекомендацию мог вписать диспетчер, пока инженер был на объекте. Свёрнутое
   * состояние вычислялось ОДИН раз при монтировании — и пришедший позже текст
   * оставался за кнопкой, о которой инженер не знает, что под ней что-то есть.
   */
  it('рекомендация пришла с сервера позже — разворачивается сама', async () => {
    const server = makeServer();
    goOnline();
    renderEditor('card', server);
    await screen.findByRole('button', { name: /рекомендаци/i });

    // Диспетчер вписал рекомендацию, экран перечитал наряд.
    server.order.recommendation = 'Рекомендовано к списанию';
    fireEvent.change(await screen.findByLabelText(/Что было и что сделал/i), {
      target: { value: 'осмотрел' },
    });
    fireEvent.blur(await screen.findByLabelText(/Что было и что сделал/i));

    await screen.findByDisplayValue('Рекомендовано к списанию');
  });
});

/**
 * Строку наряда мы спрашиваем перед удалением (#113), а текст, который клиент
 * подписывает, затирали молча. Спрашиваем только когда есть что терять: на
 * пустом наряде лишний вопрос мешал бы работать.
 */
describe('«Применить» не затирает чужую работу молча', () => {
  it('в наряде уже есть текст — спрашиваем и показываем, что заменим', async () => {
    const server = makeServer({ diagnosis: 'Пробой платы питания (написал диспетчер)' });
    await typeAndCompose(server);

    fireEvent.click(await screen.findByRole('button', { name: /^Применить$/ }));

    // Вопрос показывает ИМЕННО то, что исчезнет, — иначе решать не по чему.
    await screen.findByText(/Пробой платы питания \(написал диспетчер\)/);
    fireEvent.click(await screen.findByRole('button', { name: /Отмена/ }));

    // ⚠️ Проверяем ПО СЕРВЕРУ. Раньше assert смотрел в офлайн-очередь, а
    // действие шло онлайн: очередь пуста всегда, и упасть тест не мог —
    // он был зелёным и при работающей кнопке, и при сломанной.
    await new Promise((r) => setTimeout(r, 60));
    expect(server.order.diagnosis).toBe('Пробой платы питания (написал диспетчер)');
    // Записи исходника (engineerNotes) тут законны — нельзя было только трогать акт.
    expect(server.writes.filter((w) => 'diagnosis' in w || 'repairDescription' in w)).toHaveLength(
      0,
    );
  });

  it('на пустом наряде вопроса нет — терять нечего', async () => {
    const server = makeServer();
    await typeAndCompose(server);

    fireEvent.click(await screen.findByRole('button', { name: /^Применить$/ }));

    await waitFor(() => expect(server.order.diagnosis).toBe(COMPOSED.diagnosis));
    expect(screen.queryByRole('button', { name: /Заменить/ })).toBeNull();
  });
});

/**
 * Правки предложенного текста — это работа человека, иногда несколько минут.
 * Жили они только в состоянии React: ни черновика, ни записи. Любой уход с
 * экрана и любое повторное «Оформить» стирали их без следа и без вопроса.
 */
describe('выправленное предложение не пропадает', () => {
  it('без связи «Оформить» не выбрасывает уже выправленное', async () => {
    const server = makeServer();
    await typeAndCompose(server);
    fireEvent.change(await screen.findByLabelText(/^Диагноз$/i), {
      target: { value: 'Выгорела силовая плата, следы перегрева' },
    });

    goOffline();
    fireEvent.click(await screen.findByRole('button', { name: /Оформить/ }));
    await screen.findByText(/появится связь|появится сеть/i);

    // Панель на месте, правка цела.
    await screen.findByDisplayValue('Выгорела силовая плата, следы перегрева');
  });

  it('ушёл с экрана и вернулся — правка восстановилась из памяти телефона', async () => {
    const server = makeServer();
    const view = await typeAndCompose(server);
    void view;
    fireEvent.change(await screen.findByLabelText(/^Диагноз$/i), {
      target: { value: 'Выгорела силовая плата' },
    });

    cleanup();
    renderEditor('card', server);

    await screen.findByDisplayValue('Выгорела силовая плата');
  });
});

/**
 * Исходник инженера — единственное доказательство того, что человек написал на
 * самом деле. При разборе «почему в акте ерунда» смотреть надо именно на него,
 * а видел его до сих пор только сам автор на своём телефоне.
 */
describe('на десктопе видно, что инженер написал своими словами', () => {
  it('текст показан и НЕ редактируется — это свидетельство, а не поле', async () => {
    const raw = 'плата сгорела поменял всё пашет';
    renderEditor('table', makeServer({ engineerNotes: raw }));

    await screen.findByText(raw);
    // Не в поле ввода: диспетчер не должен править чужие слова.
    expect(screen.queryByDisplayValue(raw)).toBeNull();
  });

  it('инженер своими словами ничего не писал — блока нет вовсе', async () => {
    renderEditor('table');
    await screen.findByText('Диагноз');
    expect(screen.queryByText(/Инженер написал своими словами/i)).toBeNull();
  });
});

/**
 * Черновик в памяти телефона — последняя страховка: его пишут на каждую букву,
 * и он один переживает выгрузку приложения из памяти.
 *
 * ⚠️ Стирали его по ответу на сохранение, НЕ СВЕРЯЯСЬ с тем, что в поле сейчас.
 * Инженер печатает дальше, пока запись идёт (а без связи она идёт через
 * IndexedDB, это не мгновенно) — и дописанное оставалось без страховки вовсе.
 */
describe('черновик стирается только вместе с тем, что записали', () => {
  it('дописал, пока шла запись — дописанное остаётся под страховкой', async () => {
    renderEditor('card');
    const field = await screen.findByLabelText(/Что было и что сделал/i);

    fireEvent.change(field, { target: { value: 'плата сгорела' } });
    fireEvent.blur(field); // запись пошла
    // ...и человек продолжает печатать, не дожидаясь её конца.
    fireEvent.change(field, { target: { value: 'плата сгорела, поменял' } });

    await waitFor(async () => {
      expect(await queuedText()).toContain('плата сгорела');
    });
    const draft = localStorage.getItem(`erfolg-draft:${TICKET}:engineerNotes`);
    expect(draft).not.toBeNull();
    expect(String(draft)).toContain('плата сгорела, поменял');
  });

  it('ничего не дописывал — страховка снимается, как и раньше', async () => {
    renderEditor('card');
    const field = await screen.findByLabelText(/Что было и что сделал/i);

    fireEvent.change(field, { target: { value: 'не греет' } });
    fireEvent.blur(field);

    await waitFor(async () => {
      expect(await queuedText()).toContain('не греет');
    });
    await waitFor(() => {
      expect(localStorage.getItem(`erfolg-draft:${TICKET}:engineerNotes`)).toBeNull();
    });
  });
});

/**
 * Десктопная кнопка «ИИ-черновик» (фича №13) собирает текст из СТРОК наряда и
 * вписывает его в поле. Текст, который человек уже набрал, она затирала без
 * вопроса — с этого и начался весь разбор «инженер пишет своими словами».
 * Кнопку оставляем (диспетчеру она к месту), но молча терять работу нельзя.
 */
describe('«ИИ-черновик» на десктопе не затирает набранное молча', () => {
  it('в поле есть текст — спрашиваем', async () => {
    const server = makeServer();
    goOnline();
    renderEditor('table', server);

    const field = await screen.findByLabelText(/Описание ремонта/i);
    fireEvent.change(field, { target: { value: 'Мой текст, который жалко' } });
    fireEvent.click(await screen.findByRole('button', { name: /ИИ-черновик/ }));

    // Вопрос задан, и черновик за ним ещё НЕ запрашивался.
    await screen.findByText('В поле уже есть текст');
    expect(server.draftCalls).toBe(0);

    fireEvent.click(await screen.findByRole('button', { name: /Отмена/ }));
    expect((field as HTMLTextAreaElement).value).toBe('Мой текст, который жалко');
    expect(server.draftCalls).toBe(0);
  });

  /**
   * Собирать не из чего — не повод писать в акт «работы выполнены в полном
   * объёме». Сервер отдаёт пустой текст, экран говорит словами и НЕ трогает
   * поле: затирать чужой текст пустотой — худшее из возможного.
   */
  it('в наряде нет строк — говорим словами, поле не трогаем', async () => {
    const server = makeServer();
    server.draftText = '';
    goOnline();
    renderEditor('table', server);

    const field = await screen.findByLabelText(/Описание ремонта/i);
    fireEvent.change(field, { target: { value: 'Мой текст' } });
    fireEvent.click(await screen.findByRole('button', { name: /ИИ-черновик/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Заменить/ }));

    await screen.findByText(/не из чего|нет ни строк/i);
    expect((field as HTMLTextAreaElement).value).toBe('Мой текст');
  });

  it('поле пустое — вопроса нет, терять нечего', async () => {
    const server = makeServer();
    goOnline();
    renderEditor('table', server);

    fireEvent.click(await screen.findByRole('button', { name: /ИИ-черновик/ }));

    await waitFor(() => expect(server.draftCalls).toBe(1));
    expect(screen.queryByText('В поле уже есть текст')).toBeNull();
  });
});

/**
 * Без связи запрос не падает, а ВИСИТ на паузе — так намертво зависал сканер
 * (#112). Поэтому в сеть без связи не ходим вовсе и говорим об этом словами.
 */
describe('без связи оформить нельзя — и об этом сказано', () => {
  it('в сеть не идём, набранное всё равно записано', async () => {
    // Сохранение исходника в сеть уходит и честно падает — на этом падении и
    // держится вся очередь (см. query-defaults). Считаем только оформление.
    const server = makeServer();
    renderEditor('card', server);
    const field = await screen.findByLabelText(/Что было и что сделал/i);
    fireEvent.change(field, { target: { value: 'не греет' } });

    fireEvent.click(await screen.findByRole('button', { name: /Оформить/ }));

    await screen.findByText(/появится связь|появится сеть/i);
    expect(server.composeCalls).toBe(0);

    // Главное обещание: текст человека не потерян, он просто ждёт сети.
    await waitFor(async () => {
      expect(await queuedText()).toContain('не греет');
    });
  });
});
