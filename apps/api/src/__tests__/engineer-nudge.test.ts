/**
 * Нуджи инженерам: привязка Telegram, реакция одной кнопкой, правила воркера.
 *
 * Тесты:
 *   1. Link-код одноразовый: consumeLinkCode гасит код (второй раз null).
 *   2. linkChatToUser перевешивает chat_id с прежнего сотрудника (уникальность).
 *   3. handler: «/start link_<code>» привязывает чат, findUserByChatId находит.
 *   4. handler: callback «жду запчасть» ставит blocked_reason на МОЮ заявку.
 *   5. handler: callback по ЧУЖОЙ заявке инженером — отказ, заявка не тронута.
 *   6. tRPC engineerReact: inwork пишет note; ready (diagnostics) доводит до act_pending
 *      через in_progress; чужая заявка инженеру — FORBIDDEN.
 *   7. tRPC myList/myTickets доступны инженеру (фикс FORBIDDEN на /m/queue)
 *      и отдают только его заявки.
 *   8. Воркер: pickAskCandidates фильтрует по порогам доски; календарные хелперы
 *      считают день/минуты/рабочий день в таймзоне.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { getDb, clients, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket, type BoardTicketDto } from '../modules/tickets/repository';
import { handleUpdate } from '../modules/telegram/handler';
import {
  consumeLinkCode,
  createLinkCode,
  findUserByChatId,
  getChatIdForUser,
  linkChatToUser,
  unlinkChat,
} from '../modules/telegram/staff-link';
import {
  dateInTz,
  isWorkdayInTz,
  minutesOfDayInTz,
  pickAskCandidates,
} from '../workers/engineer-nudge';
import { tryAcquireAskSlot } from '../lib/nudge-state';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';
import type { TgUpdate } from '../lib/telegram-client';

const TEST_PREFIX = 'TEST-NUDGE-';
const CHAT_A = 555_001_001;
const CHAT_B = 555_001_002;
const FAKE_TOKEN = '1:fake';

let erfolgId = '';
let clientId = '';
let engineerId = '';
let engineer2Id = '';
let dispatcherId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const engineers = usrs.filter((u) => u.role === 'engineer');
  const engineer = engineers[0];
  if (!engineer) throw new Error('seed missing engineer');
  engineerId = engineer.id;
  // Второй инженер не обязателен в сиде — для «чужой заявки» хватит и диспетчера как владельца.
  engineer2Id = engineers[1]?.id ?? '';
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!disp) throw new Error('seed missing dispatcher');
  dispatcherId = disp.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    await tx.update(users).set({ telegramChatId: null }).where(eq(users.tenantId, erfolgId));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

const handlerCtx = () => ({
  db: getDb(),
  tenant: {
    id: erfolgId,
    subdomain: 'erfolg',
    displayName: 'erfolg',
    status: 'active' as const,
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  },
  botToken: FAKE_TOKEN,
  defaultDispatcherUserId: null,
});

function makeMessage(text: string, chatId = CHAT_A): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: Math.floor(Math.random() * 1_000_000),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      text,
    },
  };
}

function makeCallback(data: string, chatId = CHAT_A): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    callback_query: {
      id: String(Math.floor(Math.random() * 1_000_000)),
      data,
      from: { id: chatId, is_bot: false },
      message: {
        message_id: Math.floor(Math.random() * 1_000_000),
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        text: 'нудж-вопрос',
      },
    },
  };
}

async function makeTestTicket(opts?: { engineerId?: string | null }): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}ticket`,
    assignedEngineerId: opts?.engineerId ?? engineerId,
  });
  return id;
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(opts: { role: 'director' | 'dispatcher' | 'engineer'; userId?: string }): Context {
  const userId = opts.userId ?? (opts.role === 'engineer' ? engineerId : dispatcherId);
  const session: SessionData = {
    tenantId: erfolgId,
    userId,
    username: `${opts.role}-test`,
    role: opts.role,
    fullName: `Test ${opts.role}`,
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: erfolgId,
      subdomain: 'erfolg',
      displayName: 'erfolg',
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    },
    session,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
  };
}

describe('Привязка Telegram (staff-link)', () => {
  it('link-код одноразовый', async () => {
    const code = await createLinkCode(erfolgId, engineerId);
    const first = await consumeLinkCode(code);
    expect(first).toEqual({ tenantId: erfolgId, userId: engineerId });
    const second = await consumeLinkCode(code);
    expect(second).toBeNull();
  });

  it('linkChatToUser перевешивает chat_id с прежнего сотрудника', async () => {
    await linkChatToUser(getDb(), erfolgId, dispatcherId, CHAT_A);
    expect(await getChatIdForUser(getDb(), erfolgId, dispatcherId)).toBe(CHAT_A);
    // Тот же чат уходит инженеру — у диспетчера привязка снимается.
    await linkChatToUser(getDb(), erfolgId, engineerId, CHAT_A);
    expect(await getChatIdForUser(getDb(), erfolgId, engineerId)).toBe(CHAT_A);
    expect(await getChatIdForUser(getDb(), erfolgId, dispatcherId)).toBeNull();
    await unlinkChat(getDb(), erfolgId, engineerId);
    expect(await getChatIdForUser(getDb(), erfolgId, engineerId)).toBeNull();
  });

  it('«/start link_<code>» через handler привязывает чат', async () => {
    stubFetch();
    const code = await createLinkCode(erfolgId, engineerId);
    await handleUpdate(handlerCtx(), makeMessage(`/start link_${code}`));
    const found = await findUserByChatId(getDb(), erfolgId, CHAT_A);
    expect(found?.id).toBe(engineerId);
  });
});

describe('Callback-кнопки в Telegram', () => {
  it('«жду запчасть» ставит blocked_reason на мою заявку и правит сообщение', async () => {
    const fetchSpy = stubFetch();
    await linkChatToUser(getDb(), erfolgId, engineerId, CHAT_A);
    const ticketId = await makeTestTicket();

    await handleUpdate(handlerCtx(), makeCallback(`r:pt:${ticketId}`));

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ blockedReason: tickets.blockedReason, waitingForPart: tickets.waitingForPart })
        .from(tickets)
        .where(eq(tickets.id, ticketId)),
    );
    expect(row?.blockedReason).toBe('waiting_part');
    expect(row?.waitingForPart).toBe(true);

    const methods = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(methods.some((u) => u.includes('answerCallbackQuery'))).toBe(true);
    expect(methods.some((u) => u.includes('editMessageText'))).toBe(true);
  });

  it('чужая заявка: инженер получает отказ, заявка не тронута', async () => {
    const fetchSpy = stubFetch();
    await linkChatToUser(getDb(), erfolgId, engineerId, CHAT_A);
    // Заявка на другого владельца (второй инженер или диспетчер).
    const foreignOwner = engineer2Id || dispatcherId;
    const ticketId = await makeTestTicket({ engineerId: foreignOwner });

    await handleUpdate(handlerCtx(), makeCallback(`r:pt:${ticketId}`));

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ blockedReason: tickets.blockedReason })
        .from(tickets)
        .where(eq(tickets.id, ticketId)),
    );
    expect(row?.blockedReason).toBeNull();

    // Отказ ушёл в answerCallbackQuery, editMessageText не звался.
    const methods = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(methods.some((u) => u.includes('answerCallbackQuery'))).toBe(true);
    expect(methods.some((u) => u.includes('editMessageText'))).toBe(false);
  });

  it('непривязанный чат получает подсказку про привязку', async () => {
    const fetchSpy = stubFetch();
    const ticketId = await makeTestTicket();
    await handleUpdate(handlerCtx(), makeCallback(`r:iw:${ticketId}`, CHAT_B));
    const answerCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('answerCallbackQuery'),
    );
    expect(answerCall).toBeDefined();
    const body = JSON.parse((answerCall?.[1]?.body as string) ?? '{}');
    expect(String(body.text)).toMatch(/привяз/i);
  });

  it('привязанный сотрудник на /start получает справку, а не клиентскую анкету', async () => {
    const fetchSpy = stubFetch();
    await linkChatToUser(getDb(), erfolgId, engineerId, CHAT_A);
    await handleUpdate(handlerCtx(), makeMessage('/start'));
    const sendCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('sendMessage'));
    const body = JSON.parse((sendCall?.[1]?.body as string) ?? '{}');
    expect(String(body.text)).toMatch(/сотрудник/i);
    expect(String(body.text)).not.toMatch(/зовут/i);
  });
});

describe('tRPC: engineerReact / myTickets / myList', () => {
  it('inwork пишет note-событие в журнал', async () => {
    const ticketId = await makeTestTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    const res = await caller.tickets.engineerReact({ ticketId, action: 'inwork' });
    expect(res.kind).toBe('inwork');
    const events = await caller.tickets.events({ ticketId });
    expect(
      events.some((e) => {
        const payload = e.payload as { comment?: string } | null;
        return e.type === 'note' && payload?.comment?.includes('ещё в работе');
      }),
    ).toBe(true);
  });

  /**
   * ⚠️ ЖАЛОБА С БОЯ (фото телефона инженера, 2026-08-08): «инженер нажимает,
   * что аппарат в работе, а плашка всё равно выходит при каждом входе».
   *
   * Так и было. Сервер на «Ещё в работе» ставит отметку «молчать 2 дня»
   * (snoozeAsk, Redis) — и бот замолкает, как обещано человеку словами
   * «пару дней не беспокою». А блок «Провисло» в мобильном списке считался
   * БЕЗ этой отметки, карточка пряталась только в памяти страницы (useState).
   * Закрыл приложение — память очистилась, плашка вернулась.
   *
   * То есть программа обещала одно, а делала другое. Инженеру, которого и так
   * просили «минимизировать контакт с программой».
   */
  it('после «ещё в работе» заявка помечена «молчим» — и плашка это увидит', async () => {
    const ticketId = await makeTestTicket();
    const other = await makeTestTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    const before = await caller.tickets.myTickets();
    expect(before.find((t) => t.id === ticketId)?.askSnoozed).toBe(false);

    await caller.tickets.engineerReact({ ticketId, action: 'inwork' });

    const after = await caller.tickets.myTickets();
    expect(after.find((t) => t.id === ticketId)?.askSnoozed).toBe(true);
    // Соседняя заявка не должна замолчать заодно.
    expect(after.find((t) => t.id === other)?.askSnoozed).toBe(false);
  });

  /**
   * ⚠️ ИЗЪЯН, НАЙДЕННЫЙ ПРОВЕРКОЙ НА БОЮ (2026-08-08, сразу после выката).
   *
   * Отметка «молчим по заявке» — ОДИН ключ на два разных события: его ставит и
   * `tryAcquireAskSlot` («бот только что спросил», дедуп), и `snoozeAsk`
   * («инженер ответил»). Плашка, читавшая этот ключ, замолкала бы и в первом
   * случае — то есть ровно тогда, когда инженер НИЧЕГО не ответил, а бот
   * успел спросить первым. Вопрос исчезал бы с экрана сам собой.
   *
   * Различаем по значению: '1' — спросили, 'answered' — ответили.
   */
  it('бот спросил, но инженер молчит — плашку не прячем', async () => {
    const ticketId = await makeTestTicket();
    // Так делает воркер, когда шлёт нудж.
    await tryAcquireAskSlot(erfolgId, ticketId);

    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    const mine = await caller.tickets.myTickets();
    expect(mine.find((t) => t.id === ticketId)?.askSnoozed).toBe(false);
  });

  it('ready из diagnostics доводит до act_pending через in_progress', async () => {
    const ticketId = await makeTestTicket();
    const dispatcherCaller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await dispatcherCaller.tickets.changeStatus({ id: ticketId, status: 'diagnostics' });

    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    const res = await caller.tickets.engineerReact({ ticketId, action: 'ready' });
    expect(res.kind).toBe('ready');
    const t = await caller.tickets.get({ id: ticketId });
    expect(t?.status).toBe('act_pending');
  });

  /**
   * «Взял в работу» одной кнопкой из списка.
   *
   * ЗАЧЕМ. Владелец 2026-08-08: «инженеры не любят приложение, надо
   * минимизировать их контакт с программой — они видят, что назначили, и
   * реагируют: в ремонте / сделал / жду запчасть».
   *
   * Сегодня самой частой из трёх реакций — «взял в работу» — у инженера нет
   * вовсе: свежая заявка в статусе «Принята», и чтобы сдвинуть её, надо
   * открыть карточку, нажать «Начать диагностику», потом «В работу» и уйти
   * назад — четыре тапа и два экрана на каждую заявку. Кнопка из списка
   * должна делать то же самое одним нажатием, как это уже делает `ready`
   * (он тоже проходит цепочку статусов за один вызов).
   */
  it('start из «Принята» доводит до «В работе» через диагностику', async () => {
    const ticketId = await makeTestTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    const res = await caller.tickets.engineerReact({ ticketId, action: 'start' });

    expect(res.kind).toBe('start');
    const t = await caller.tickets.get({ id: ticketId });
    expect(t?.status).toBe('in_progress');
  });

  it('start по уже начатой заявке ничего не ломает', async () => {
    const ticketId = await makeTestTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await caller.tickets.engineerReact({ ticketId, action: 'start' });

    // Второй тап по той же кнопке (палец соскользнул, связь моргнула,
    // очередь отправила повтор) не должен ни падать, ни двигать статус дальше.
    const again = await caller.tickets.engineerReact({ ticketId, action: 'start' });

    expect(again.kind).toBe('noop');
    const t = await caller.tickets.get({ id: ticketId });
    expect(t?.status).toBe('in_progress');
  });

  it('start по чужой заявке — отказ', async () => {
    const foreignOwner = engineer2Id || dispatcherId;
    const ticketId = await makeTestTicket({ engineerId: foreignOwner });
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    await expect(caller.tickets.engineerReact({ ticketId, action: 'start' })).rejects.toThrow();
  });

  /**
   * Сторож: сервер «жду запчасть» на свежей заявке принимал ВСЕГДА — мешал
   * только экран, где кнопка показывалась лишь у «провисших». Если этот тест
   * когда-нибудь покраснеет, значит запрет уехал на сервер, и чинить надо там.
   */
  it('«жду запчасть» принимается и на свежей заявке — дело было не в сервере', async () => {
    const ticketId = await makeTestTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    const res = await caller.tickets.engineerReact({ ticketId, action: 'part' });

    expect(res.kind).toBe('part');
  });

  it('чужая заявка инженеру — FORBIDDEN; диспетчеру — можно', async () => {
    const foreignOwner = engineer2Id || dispatcherId;
    const ticketId = await makeTestTicket({ engineerId: foreignOwner });
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expect(
      caller.tickets.engineerReact({ ticketId, action: 'inwork' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const staffCaller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const res = await staffCaller.tickets.engineerReact({ ticketId, action: 'inwork' });
    expect(res.kind).toBe('inwork');
  });

  it('myList и myTickets работают под инженером и отдают только его заявки', async () => {
    const mineId = await makeTestTicket();
    const foreignOwner = engineer2Id || dispatcherId;
    const foreignId = await makeTestTicket({ engineerId: foreignOwner });

    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    const list = await caller.tickets.myList({ pageSize: 100 });
    const listIds = list.items.map((t) => t.id);
    expect(listIds).toContain(mineId);
    expect(listIds).not.toContain(foreignId);

    const board = await caller.tickets.myTickets();
    const boardIds = board.map((t) => t.id);
    expect(boardIds).toContain(mineId);
    expect(boardIds).not.toContain(foreignId);
    const mine = board.find((t) => t.id === mineId);
    expect(mine?.light).toBeDefined();
    expect(mine?.stuckDays).toBeGreaterThanOrEqual(0);
  });
});

describe('Воркер engineer-nudge: правила', () => {
  const card = (over: Partial<BoardTicketDto>): BoardTicketDto => ({
    id: 'x',
    ticketNumber: 'T-1',
    status: 'in_progress',
    priority: 'normal',
    clientId: 'c',
    clientDisplayName: 'Клиент',
    assetId: null,
    assetModel: null,
    deviceType: null,
    assignedEngineerId: 'e1',
    assignedEngineerName: 'Инженер',
    assignedDispatcherId: null,
    assignedDispatcherName: null,
    waitingForPart: false,
    waitingForPartNote: null,
    blockedReason: null,
    effectiveReason: null,
    blockedSince: null,
    slaTargetAt: null,
    idleDays: 0,
    stuckDays: 4,
    light: 'yellow',
    ...over,
  });

  it('pickAskCandidates: берёт застой ≥3 дн без причины, сортирует по дням', () => {
    const picked = pickAskCandidates([
      card({ id: 'a', stuckDays: 3 }),
      card({ id: 'b', stuckDays: 9 }),
      card({ id: 'skip-reason', effectiveReason: 'waiting_part' }),
      card({ id: 'skip-fresh', stuckDays: 2 }),
      card({ id: 'skip-unassigned', assignedEngineerId: null }),
      card({ id: 'skip-status', status: 'act_pending' }),
      // received не нуджим: работа не начата, кнопки «готово/запчасть» бессмысленны
      card({ id: 'skip-received', status: 'received' }),
    ]);
    expect(picked.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('календарные хелперы считают в таймзоне организации', () => {
    // 2026-07-03 21:30 UTC = 2026-07-04 00:30 в Москве (пятница→суббота)
    const d = new Date('2026-07-03T21:30:00Z');
    expect(dateInTz(d, 'Europe/Moscow')).toBe('2026-07-04');
    expect(minutesOfDayInTz(d, 'Europe/Moscow')).toBe(30);
    expect(isWorkdayInTz(d, 'Europe/Moscow')).toBe(false); // суббота
    expect(isWorkdayInTz(d, 'UTC')).toBe(true); // ещё пятница
    // Рабочее утро в Москве
    const morning = new Date('2026-07-03T05:45:00Z'); // 08:45 МСК, пятница
    expect(minutesOfDayInTz(morning, 'Europe/Moscow')).toBe(8 * 60 + 45);
    expect(isWorkdayInTz(morning, 'Europe/Moscow')).toBe(true);
  });
});
