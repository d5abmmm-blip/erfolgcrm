/**
 * Фича №13 — ИИ-черновик текста «Выполненные работы» для акта.
 *
 * В тест-окружении LLM не настроен (env LLM_* пусты, llm_configs пуст) → phraseWithLlm
 * возвращает null → срабатывает ДЕТЕРМИНИРОВАННЫЙ фолбэк (черновик из строк наряда).
 * Покрытие:
 *   1. Фолбэк собирает текст из названий работ + запчастей (aiUsed=false).
 *   2. Пустой наряд (нет строк, нет диагноза) → базовый текст, ИИ не зовём.
 *   3. Наряд не создан → BAD_REQUEST.
 *   4. RBAC: engineer имеет доступ (процедура engineerProcedure).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { phraseWithLlm } from '../modules/ai-assistant/proactive';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';
import type * as ProactiveModule from '../modules/ai-assistant/proactive';

// Модель подменяем: по умолчанию «не настроена» (null) — прежние тесты фолбэка
// не меняются; в тестах сторожа отвечаем за неё mockResolvedValueOnce.
vi.mock('../modules/ai-assistant/proactive', async (importOriginal) => {
  const orig = await importOriginal<typeof ProactiveModule>();
  return { ...orig, phraseWithLlm: vi.fn(async () => null) };
});

const TEST_PREFIX = 'TEST-ACTDRAFT-';

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

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}
beforeEach(clearTestData);

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

async function makeTicketWithOrder(): Promise<{ ticketId: string; workOrderId: string }> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}не включается`,
    // Заявка своя: инженер правит наряд только по своим (решение владельца
    // 2026-08-07, «смотреть всем, менять — только свои»).
    assignedEngineerId: engineerId,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  return { ticketId, workOrderId: wo.id };
}

describe('draftRepairDescription (ИИ-черновик акта)', () => {
  it('без LLM собирает черновик из строк наряда (aiUsed=false)', async () => {
    const { ticketId, workOrderId } = await makeTicketWithOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Замена платы питания',
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 350_000n,
    });
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'part',
      name: 'Плата питания Mindray PSU-70',
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 2_850_000n,
    });

    const caller = appRouter.createCaller(makeCtx('engineer'));
    const res = await caller.workOrders.draftRepairDescription({ ticketId });

    expect(res.aiUsed).toBe(false);
    expect(res.text).toContain('Замена платы питания');
    expect(res.text).toContain('Плата питания Mindray PSU-70');
    /**
     * ⚠️ И НИ СЛОВА СВЕРХ СТРОК НАРЯДА. Здесь дописывалась готовая фраза
     * «Оборудование протестировано, работоспособность восстановлена» — два
     * утверждения (о процедуре и о результате), которых никто не делал, под
     * подписью клиента. В пути инженера её убрали, а здесь она оставалась.
     */
    expect(res.text).not.toMatch(/протестировано/i);
    expect(res.text).not.toMatch(/работоспособность/i);
  });

  it('пустой наряд — черновик собирать НЕ ИЗ ЧЕГО, и мы это говорим', async () => {
    // «Работы по заявке выполнены в полном объёме» при нуле строк и пустом
    // диагнозе — заявление, за которым в системе нет вообще ничего.
    const { ticketId } = await makeTicketWithOrder();
    const caller = appRouter.createCaller(makeCtx('engineer'));
    const res = await caller.workOrders.draftRepairDescription({ ticketId });
    expect(res.aiUsed).toBe(false);
    expect(res.text).toBe('');
  });

  it('фолбэк без строк, но с диагнозом → диагноз не теряется', async () => {
    const { ticketId } = await makeTicketWithOrder();
    const caller = appRouter.createCaller(makeCtx('engineer'));
    await caller.workOrders.updateHeader({
      ticketId,
      patch: { diagnosis: 'Пробой платы питания' },
    });
    const res = await caller.workOrders.draftRepairDescription({ ticketId });
    expect(res.aiUsed).toBe(false);
    expect(res.text).toContain('Пробой платы питания');
  });

  it('наряд не создан → BAD_REQUEST', async () => {
    const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}без наряда`,
    });
    const caller = appRouter.createCaller(makeCtx('engineer'));
    await expect(caller.workOrders.draftRepairDescription({ ticketId })).rejects.toThrow(/наряд/i);
  });

  /**
   * Сторож от выдумок — тот же, что в пути инженера (#118, inventsFacts).
   * Текст уходит в акт под подпись клиента: выдуманная гарантия или срок —
   * обязательство компании, которого никто не давал. Ответ модели с числом
   * не из входа или словом «гарантия» не принимается — берётся честный
   * черновик из строк наряда, а экран говорит об этом прямо.
   */
  it('модель приписала гарантию — её текст не принимается, берётся фолбэк', async () => {
    const { ticketId, workOrderId } = await makeTicketWithOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Замена платы питания',
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 350_000n,
    });
    vi.mocked(phraseWithLlm).mockResolvedValueOnce(
      'Выполнена замена платы питания. Гарантия на работы — 6 месяцев.',
    );

    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const res = await caller.workOrders.draftRepairDescription({ ticketId });

    expect(res.aiUsed).toBe(false);
    expect(res.aiRejected).toBe(true);
    expect(res.text).toContain('Замена платы питания');
    expect(res.text).not.toMatch(/гаранти/i);
    expect(res.text).not.toContain('6 месяцев');
  });

  it('модель ответила по делу — её текст берётся (aiUsed=true)', async () => {
    const { ticketId, workOrderId } = await makeTicketWithOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Замена платы питания',
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 350_000n,
    });
    vi.mocked(phraseWithLlm).mockResolvedValueOnce('Выполнена замена платы питания.');

    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const res = await caller.workOrders.draftRepairDescription({ ticketId });

    expect(res.aiUsed).toBe(true);
    expect(res.aiRejected).toBe(false);
    expect(res.text).toBe('Выполнена замена платы питания.');
  });

  it('в фолбэке без модели aiRejected=false — «не настроен» и «фантазирует» разные новости', async () => {
    const { ticketId, workOrderId } = await makeTicketWithOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Диагностика',
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 100_000n,
    });
    const caller = appRouter.createCaller(makeCtx('engineer'));
    const res = await caller.workOrders.draftRepairDescription({ ticketId });
    expect(res.aiUsed).toBe(false);
    expect(res.aiRejected).toBe(false);
  });

  it('диспетчер тоже имеет доступ (staff ⊆ engineerProcedure)', async () => {
    const { ticketId, workOrderId } = await makeTicketWithOrder();
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: 'Диагностика',
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 100_000n,
    });
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const res = await caller.workOrders.draftRepairDescription({ ticketId });
    expect(res.text).toContain('Диагностика');
  });
});
