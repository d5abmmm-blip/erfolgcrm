/**
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (2026-07-23): почта не должна отправлять ничего САМА.
 *
 * Раньше система писала клиентам без участия человека в двух местах:
 *   1. при каждой смене статуса заявки (воркер ticket-status-notify);
 *   2. каждый день в 9:00 — напоминания о просроченных счетах (воркер invoice-reminder).
 * Оба выключены. Письмо уходит только тогда, когда его отправил ЧЕЛОВЕК:
 * кнопка «Напомнить» в Дебиторке и раздел «Почта» (включая «отправить позже» —
 * время выбирает человек).
 *
 * ⚠️ ВАЖНО, ЧТО ИМЕННО НЕ ТРОГАЕМ: ночной тик оставлен жить, потому что кроме писем
 * он делает нужную работу — помечает счета просроченными (`markOverdueAsOf`). От этой
 * пометки зависят дашборд, отчёты и кабинет клиента, поэтому убить тик целиком было
 * нельзя, вырезана только рассылка. Тест ниже сторожит ровно это.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';

/** Перехватываем очередь: важно не «письмо не ушло» (воркеров в тестах нет),
 *  а что задача на отправку вообще НЕ СТАВИТСЯ. */
const hoisted = vi.hoisted(() => {
  const added: Array<{ queue: string; jobName: string }> = [];
  return { added };
});

vi.mock('../lib/queue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getQueue: (name: string) => ({
      add: (jobName: string) => {
        hoisted.added.push({ queue: name, jobName });
        return Promise.resolve({ id: 'mock' });
      },
    }),
  };
});

import { getDb, invoices, payments, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { createClient } from '../modules/clients/repository';
import {
  createDraft,
  listClientOverdueInvoices,
  transitionToIssued,
} from '../modules/invoices/repository';
import { sendReminderCmd } from '../modules/invoices/service';
import { processInvoiceReminderTick } from '../workers/invoice-reminder';
import { __setTransporterForTesting } from '../lib/mailer';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TESTNOAUTO-';
const NOTIFY_QUEUE = 'ticket-status-notify';

let erfolgId = '';
let staffUserId = '';
let clientSeq = 0;

const sentMail: Array<{ to: string; subject: string }> = [];

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  // Любой активный сотрудник — для userId в сессии (аудит и ticket_events по FK).
  const [u] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'dispatcher')).limit(1),
  );
  if (!u) throw new Error('seed missing dispatcher');
  staffUserId = u.id;

  __setTransporterForTesting({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMail: vi.fn(async (opts: any) => {
      sentMail.push({ to: opts.to, subject: opts.subject });
      return { messageId: `mock-${sentMail.length}` };
    }),
    close: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

afterAll(() => {
  __setTransporterForTesting(null);
});

beforeEach(async () => {
  sentMail.length = 0;
  hoisted.added.length = 0;
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(payments).where(like(payments.comment, `${TEST_PREFIX}%`));
    await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

const testTenant: ResolvedTenant = {
  id: '',
  subdomain: 'erfolg',
  displayName: 'erfolg',
  status: 'active',
  timezone: 'Europe/Moscow',
  kmsKeyId: null,
};

function makeSession(): SessionData {
  return {
    tenantId: erfolgId,
    userId: staffUserId,
    username: 'dispatcher-noauto',
    role: 'dispatcher',
    fullName: 'Тест Диспетчер',
    expiresAt: Date.now() + 3600_000,
  };
}

/** Контекст для вызова процедур через appRouter (путь «как из браузера»). */
function makeCtx(): Context {
  return {
    db: getDb(),
    tenant: { ...testTenant, id: erfolgId },
    session: makeSession(),
    ip: null,
    userAgent: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Контекст для прямого вызова команды сервиса (у него своя форма — с audit). */
function makeCmdCtx() {
  return {
    db: getDb(),
    tenant: { ...testTenant, id: erfolgId },
    session: makeSession(),
    audit: { ip: null, userAgent: null },
  };
}

/** Клиент с настоящим адресом — чтобы «не отправили» означало решение, а не отсутствие почты. */
async function makeClientWithEmail(): Promise<string> {
  clientSeq += 1;
  const { id } = await createClient(getDb(), erfolgId, {
    type: 'legal',
    displayName: `${TEST_PREFIX}client-${Date.now()}-${clientSeq}`,
    email: `noauto-${clientSeq}@example.com`,
  });
  return id;
}

/** Просроченный счёт на 1000 ₽ этому клиенту. */
async function makeOverdueInvoice(clientId: string): Promise<void> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}работа`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: 100_000n,
  });
  const draft = await createDraft(getDb(), erfolgId, {
    workOrderId: wo.id,
    notes: `${TEST_PREFIX}inv`,
  });
  const issued = await transitionToIssued(getDb(), erfolgId, draft.id, {});
  if (!issued) throw new Error('счёт не выставился');
  // Сдвигаем срок в прошлое: due_date >= issue_date по CHECK, поэтому двигаем обе даты.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx
      .update(invoices)
      .set({
        issueDate: sql`CURRENT_DATE - 10`,
        dueDate: sql`CURRENT_DATE - 5`,
      })
      .where(eq(invoices.id, issued.id));
  });
}

describe('робот НЕ пишет клиенту сам', () => {
  it('смена статуса заявки не ставит задачу на письмо', async () => {
    const clientId = await makeClientWithEmail();
    const { id } = await createTicket(getDb(), erfolgId, null, {
      clientId,
      symptom: `${TEST_PREFIX}статус`,
    });
    const caller = appRouter.createCaller(makeCtx());

    const r = await caller.tickets.changeStatus({ id, status: 'diagnostics' });

    expect(r.to).toBe('diagnostics');
    // Статус сменился — а вот письма никто не заказывал.
    expect(hoisted.added.filter((j) => j.queue === NOTIFY_QUEUE)).toHaveLength(0);
  });

  it('ни один статус из «письмовых» не ставит задачу на письмо', async () => {
    // Раньше письмо уходило на семи статусах. Проверяем всю цепочку разом, чтобы
    // случайно не оставить включённым один из них.
    const clientId = await makeClientWithEmail();
    const { id } = await createTicket(getDb(), erfolgId, null, {
      clientId,
      symptom: `${TEST_PREFIX}цепочка`,
    });
    const caller = appRouter.createCaller(makeCtx());
    for (const status of ['diagnostics', 'in_progress', 'act_pending', 'closed'] as const) {
      await caller.tickets.changeStatus({ id, status });
    }
    expect(hoisted.added.filter((j) => j.queue === NOTIFY_QUEUE)).toHaveLength(0);
  });

  it('ночной робот не шлёт напоминания о просроченных счетах', async () => {
    const clientId = await makeClientWithEmail();
    await makeOverdueInvoice(clientId);

    const stats = await processInvoiceReminderTick();

    expect(stats.remindersSent).toBe(0);
    expect(sentMail).toHaveLength(0);
  });

  it('ДАННЫЕ: ночной робот по-прежнему помечает счета просроченными', async () => {
    // Ключевая проверка: вырезана рассылка, а не весь тик. От статуса «просрочен»
    // зависят дашборд, отчёты и кабинет клиента — если сломать, цифры молча обнулятся.
    const clientId = await makeClientWithEmail();
    await makeOverdueInvoice(clientId);

    const stats = await processInvoiceReminderTick();

    expect(stats.overdueMarked).toBeGreaterThanOrEqual(1);
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.clientId, clientId)),
    );
    expect(row?.status).toBe('overdue');
  });
});

describe('человек по-прежнему может отправить письмо руками', () => {
  it('кнопка «Напомнить» в Дебиторке отправляет', async () => {
    // Регрессия: выключаем робота, а не почту. Если сломать этот путь, у директора
    // не останется вообще никакого способа напомнить клиенту о долге.
    const clientId = await makeClientWithEmail();
    await makeOverdueInvoice(clientId);
    const overdue = await listClientOverdueInvoices(getDb(), erfolgId, clientId);
    expect(overdue.length).toBeGreaterThanOrEqual(1);

    const res = await sendReminderCmd(makeCmdCtx(), clientId);

    expect(res.sent).toBe(1);
    expect(res.failed).toBe(0);
    expect(sentMail).toHaveLength(1);
  });
});
