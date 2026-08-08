/**
 * «Инженер пишет своими словами» — серверная половина.
 *
 * ЗАЧЕМ. Владелец 2026-08-08: «инженеры не любят приложение, надо
 * минимизировать их контакт с программой; они по-колхозному пишут, что
 * сломалось и что сделали, а ИИ грамотно перефразирует». Полей у наряда было
 * три, заполнять руками; кнопка «ИИ-черновик» текст инженера не читала вовсе —
 * собирала свой из строк наряда и затирала написанное.
 *
 * Здесь проверяются две вещи, которых в разборе без модели (compose-notes.ts)
 * не было:
 *   1. ИСХОДНИК ИНЖЕНЕРА ХРАНИТСЯ. Без него «Оформить» второй раз нечего
 *      разложить, а инженер уже не помнит, что писал.
 *   2. КОГДА LLM НАСТРОЕН — РАСКЛАДЫВАЕТ ОН, но под присмотром: мусор вместо
 *      JSON и выдуманные факты откатывают на честный локальный разбор.
 *
 * Почему присмотр обязателен: этот текст уходит в акт, который подписывает
 * клиент. «Гарантия 6 месяцев», которой инженер не обещал, — это обязательство
 * компании, придуманное языковой моделью.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder } from '../modules/work-orders/repository';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

/**
 * Ответ модели задаём из теста. `vi.mock` поднимается выше импортов, поэтому
 * service получит уже подменённый `phraseWithLlm`, хотя импорты записаны
 * обычным образом.
 */
const llm = vi.hoisted(() => ({
  /** null — «модель не настроена», как в тестовой среде по умолчанию. */
  answer: null as string | null,
  calls: [] as Array<{ system: string; user: string }>,
}));

vi.mock('../modules/ai-assistant/proactive', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    phraseWithLlm: (_db: unknown, _tenant: unknown, system: string, user: string) => {
      llm.calls.push({ system, user });
      return Promise.resolve(llm.answer);
    },
  };
});

const { appRouter } = await import('../trpc/router');

const TEST_PREFIX = 'TEST-ENGNOTES-';

let erfolgId = '';
let primaryClientId = '';
let engineerId = '';
let dispatcherId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  dispatcherId = usrs.find((u) => u.role === 'dispatcher')?.id ?? '';
  engineerId = usrs.find((u) => u.role === 'engineer')?.id ?? dispatcherId;
});

beforeEach(async () => {
  llm.answer = null;
  llm.calls = [];
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(role: 'engineer' | 'dispatcher'): Context {
  const userId = role === 'engineer' ? engineerId : dispatcherId;
  const session: SessionData = {
    tenantId: erfolgId,
    userId,
    username: `${role}-test`,
    role,
    fullName: `Test ${role}`,
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

/** Заявка своя: инженер правит наряд только по своим (решение владельца). */
async function myTicketWithOrder(): Promise<string> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}не включается`,
    assignedEngineerId: engineerId,
  });
  await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  return ticketId;
}

describe('исходник инженера хранится в наряде', () => {
  it('что набрал — то и вернулось, дословно и без причёсывания', async () => {
    const ticketId = await myTicketWithOrder();
    const caller = appRouter.createCaller(makeCtx('engineer'));
    const raw = 'плата сгорела поменял всё пашет';

    await caller.workOrders.updateHeader({ ticketId, patch: { engineerNotes: raw } });
    const wo = await caller.workOrders.getByTicket({ ticketId });

    // Дословно: по этому тексту инженер потом узнаёт, что писал, и «Оформить»
    // можно нажать второй раз. Причёсанное лежит в diagnosis/repairDescription.
    expect(wo?.engineerNotes).toBe(raw);
  });

  it('исходник живёт отдельно от полей акта — правка одного не трогает другое', async () => {
    const ticketId = await myTicketWithOrder();
    const caller = appRouter.createCaller(makeCtx('engineer'));

    await caller.workOrders.updateHeader({ ticketId, patch: { engineerNotes: 'не греет' } });
    await caller.workOrders.updateHeader({ ticketId, patch: { diagnosis: 'Не греет.' } });

    const wo = await caller.workOrders.getByTicket({ ticketId });
    expect(wo?.engineerNotes).toBe('не греет');
    expect(wo?.diagnosis).toBe('Не греет.');
  });
});

describe('оформление без модели', () => {
  it('LLM не настроен → раскладывает локальный разбор, и об этом сказано честно', async () => {
    const ticketId = await myTicketWithOrder();
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'плата сгорела поменял всё пашет',
    });

    expect(res.aiUsed).toBe(false);
    expect(res.diagnosis).toBe('Плата сгорела.');
    expect(res.repairDescription).toContain('Заменил');
  });

  it('пустой текст — модель не зовём вовсе и ничего не выдумываем', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer = '{"diagnosis":"Придумано","repairDescription":"Придумано"}';
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({ ticketId, notes: '   ' });

    expect(llm.calls).toHaveLength(0);
    expect(res).toEqual({
      diagnosis: null,
      repairDescription: null,
      aiUsed: false,
      // Модель не звали — жаловаться на неё не на что.
      aiRejected: false,
    });
  });
});

describe('оформление моделью', () => {
  it('модель настроена → её текст и идёт в поля', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer =
      '{"diagnosis":"Вышла из строя плата питания.","repairDescription":"Плата питания заменена, работоспособность проверена."}';
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'плата сгорела поменял всё пашет',
    });

    expect(res.aiUsed).toBe(true);
    expect(res.diagnosis).toBe('Вышла из строя плата питания.');
    expect(res.repairDescription).toBe('Плата питания заменена, работоспособность проверена.');
  });

  it('в модель уходит ТОЛЬКО текст инженера — ни клиента, ни телефона, ни адреса', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer = '{"diagnosis":"Не включается.","repairDescription":"Осмотрено."}';
    const caller = appRouter.createCaller(makeCtx('engineer'));

    await caller.workOrders.composeFromNotes({ ticketId, notes: 'приехал посмотрел не включается' });

    expect(llm.calls).toHaveLength(1);
    const sent = llm.calls[0]!.user;
    // ⚠️ Сверяем с САМИМИ ДАННЫМИ, а не с ярлыками «клиент/телефон/адрес».
    // Проверка по ярлыкам пропустила бы настоящую утечку: имя клиента в
    // промпте не подписано словом «клиент».
    const [client] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ name: clients.displayName }).from(clients).where(eq(clients.id, primaryClientId)),
    );
    expect(sent).toContain('приехал посмотрел не включается');
    expect(sent).not.toContain(ticketId);
    expect(sent).not.toContain(client!.name);
    // Симптом со слов клиента — тоже не наше дело: инженер про него не писал.
    expect(sent).not.toContain(TEST_PREFIX);
    // Длина промпта = длина текста инженера. Ничего лишнего просто не влезло.
    expect(sent.trim()).toBe('приехал посмотрел не включается');
  });

  /**
   * Контракт заявлен в шапке `composeEngineerNotesQuery`: «НИЧЕГО НЕ ПИШЕТ —
   * это предложение, которое человек ещё увидит». Экранная половина проверена,
   * серверная не была: наряд после вызова ни разу не перечитывали.
   */
  it('оформление НИЧЕГО не пишет в наряд — это предложение, а не запись', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer =
      '{"diagnosis":"Вышла из строя плата.","repairDescription":"Плата заменена."}';
    const caller = appRouter.createCaller(makeCtx('engineer'));
    await caller.workOrders.updateHeader({ ticketId, patch: { diagnosis: 'Было до вызова' } });

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'плата сгорела поменял',
    });
    expect(res.diagnosis).toBe('Вышла из строя плата.');

    const wo = await caller.workOrders.getByTicket({ ticketId });
    expect(wo?.diagnosis).toBe('Было до вызова');
    expect(wo?.repairDescription).toBeNull();
    expect(wo?.engineerNotes).toBeNull();
  });

  it('модель ответила не JSON → молча откатываемся на локальный разбор', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer = 'Конечно! Вот текст для акта: плата была заменена.';
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'плата сгорела поменял',
    });

    expect(res.aiUsed).toBe(false);
    expect(res.diagnosis).toBe('Плата сгорела.');
  });

  it('JSON в ```-заборе модель отдаёт постоянно — это не считается мусором', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer =
      '```json\n{"diagnosis":"Плата вышла из строя.","repairDescription":"Плата заменена."}\n```';
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'плата сгорела поменял',
    });

    expect(res.aiUsed).toBe(true);
    expect(res.diagnosis).toBe('Плата вышла из строя.');
  });
});

/**
 * Самое опасное. Текст подписывает клиент, поэтому обещание, которого инженер
 * не давал, дороже любой красоты формулировки.
 */
describe('модель выдумала — берём локальный разбор', () => {
  it('гарантия, которой инженер не обещал', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer =
      '{"diagnosis":"Плата вышла из строя.","repairDescription":"Плата заменена. Гарантия на работы предоставлена."}';
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'плата сгорела поменял',
    });

    expect(res.aiUsed).toBe(false);
    expect(res.repairDescription).not.toMatch(/гаранти/i);
  });

  it('срок, которого не было во входном тексте', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer =
      '{"diagnosis":"Плата вышла из строя.","repairDescription":"Плата заменена, срок службы 24 месяца."}';
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'плата сгорела поменял',
    });

    expect(res.aiUsed).toBe(false);
    expect(res.repairDescription).not.toContain('24');
  });

  /**
   * «ИИ не настроен» и «ИИ ответил, но приписал лишнее» — разные новости.
   * Первая ведёт человека в настройки, вторая — к владельцу: модель
   * фантазирует, это стоит знать. Одно сообщение на оба случая врало.
   */
  it('модель ответила, но её забраковали — это НЕ «ИИ не настроен»', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer =
      '{"diagnosis":"Плата вышла из строя.","repairDescription":"Плата заменена. Гарантия 12 месяцев."}';
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'плата сгорела поменял',
    });

    expect(res.aiUsed).toBe(false);
    expect(res.aiRejected).toBe(true);
  });

  it('модели просто нет — тогда и говорим, что её нет', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer = null;
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'плата сгорела поменял',
    });

    expect(res.aiUsed).toBe(false);
    expect(res.aiRejected).toBe(false);
  });

  it('а числа, которые инженер написал сам, модели не запрещены', async () => {
    const ticketId = await myTicketWithOrder();
    llm.answer =
      '{"diagnosis":"Вышли из строя 2 подшипника.","repairDescription":"Заменены 2 подшипника."}';
    const caller = appRouter.createCaller(makeCtx('engineer'));

    const res = await caller.workOrders.composeFromNotes({
      ticketId,
      notes: 'полетели 2 подшипника поменял',
    });

    expect(res.aiUsed).toBe(true);
    expect(res.repairDescription).toContain('2 подшипника');
  });
});

describe('чужое не оформляем', () => {
  it('заявка другого инженера → отказ, как и на правку наряда', async () => {
    const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}чужая`,
      assignedEngineerId: dispatcherId,
    });
    await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
    const caller = appRouter.createCaller(makeCtx('engineer'));

    // Ждём ИМЕННО отказ по правам. Голое `.rejects.toThrow()` было бы зелёным
    // и от «такой процедуры нет» — то есть до всякой реализации.
    await expect(
      caller.workOrders.composeFromNotes({ ticketId, notes: 'что-то починил' }),
    ).rejects.toThrow(/смотреть можно, менять нельзя/i);
  });
});
