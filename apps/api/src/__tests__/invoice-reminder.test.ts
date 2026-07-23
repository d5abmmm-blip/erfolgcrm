/**
 * Этап 8.E — ночной тик по счетам:
 *   • markOverdueAsOf переводит просроченные invoices в overdue.
 *   • listOverdueForReminder отдаёт overdue, по которым прошёл cooldown.
 *   • markReminderSent инкрементирует reminder_count + ставит lastReminderSentAt.
 *   • processInvoiceReminderTick: ТОЛЬКО markOverdue — рассылка отключена по решению
 *     владельца (2026-07-23), письма уходят лишь по кнопке человека.
 *
 * ⚠️ listOverdueForReminder и markReminderSent продолжают тестироваться: первая осталась
 * от выключенной рассылки (пригодится, если её вернут), вторую использует РУЧНАЯ кнопка
 * «Напомнить» — она живая.
 *
 * sendMail замокан через __setTransporterForTesting (jest-style).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  invoices,
  payments,
  tickets,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import {
  getOrCreateWorkOrder,
  upsertLine,
} from '../modules/work-orders/repository';
import {
  createDraft,
  listOverdueForReminder,
  markOverdueAsOf,
  markReminderSent,
  transitionToIssued,
} from '../modules/invoices/repository';
import { __setTransporterForTesting } from '../lib/mailer';
import { processInvoiceReminderTick } from '../workers/invoice-reminder';

let erfolgId = '';
let primaryClientId = '';
let testEmail = '';

const TEST_PREFIX = 'TEST8E-';

const sentMail: Array<{ to: string; subject: string }> = [];

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id, email: clients.email }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
  testEmail = `test-${Date.now()}@example.com`;
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.update(clients).set({ email: testEmail }).where(eq(clients.id, primaryClientId));
  });

  // Мокаем nodemailer transporter
  __setTransporterForTesting({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMail: vi.fn(async (opts: any) => {
      sentMail.push({ to: opts.to, subject: opts.subject });
      return { messageId: `mock-${Date.now()}` };
    }),
    close: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

afterAll(() => {
  __setTransporterForTesting(null);
});

async function clearTestData(): Promise<void> {
  sentMail.length = 0;
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(payments).where(like(payments.comment, `${TEST_PREFIX}%`));
    await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}

async function setupOverdueInvoice(): Promise<{ invoiceId: string; ticketId: string }> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}work`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: 100_000n,
  });
  const draft = await createDraft(getDb(), erfolgId, {
    workOrderId: wo.id,
    notes: `${TEST_PREFIX}reminder`,
  });
  const issued = await transitionToIssued(getDb(), erfolgId, draft.id, {});
  if (!issued) throw new Error('issue failed');
  // Сделаем due_date в прошлом — сегодня минус 5 дней
  const past = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.update(invoices).set({ dueDate: past, issueDate: past }).where(eq(invoices.id, issued.id));
  });
  return { invoiceId: issued.id, ticketId };
}

describe('invoice-reminder worker (8.E)', () => {
  beforeEach(clearTestData);

  it('markOverdueAsOf переводит просроченные issued → overdue', async () => {
    const { invoiceId } = await setupOverdueInvoice();
    const count = await markOverdueAsOf(getDb(), erfolgId, new Date());
    expect(count).toBeGreaterThanOrEqual(1);
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId)),
    );
    expect(row?.status).toBe('overdue');
  });

  it('listOverdueForReminder фильтрует по cooldown', async () => {
    const { invoiceId } = await setupOverdueInvoice();
    await markOverdueAsOf(getDb(), erfolgId, new Date());

    // Cooldown 168h: первый вызов отдаёт invoice (lastReminderSentAt NULL).
    const first = await listOverdueForReminder(getDb(), erfolgId, 168);
    const found = first.find((i) => i.id === invoiceId);
    expect(found).toBeDefined();

    // Помечаем как отправленный
    await markReminderSent(getDb(), erfolgId, invoiceId);

    // Повторный вызов с тем же cooldown — invoice уже не в списке.
    const second = await listOverdueForReminder(getDb(), erfolgId, 168);
    expect(second.find((i) => i.id === invoiceId)).toBeUndefined();
  });

  it('markReminderSent инкрементирует reminder_count', async () => {
    const { invoiceId } = await setupOverdueInvoice();
    await markOverdueAsOf(getDb(), erfolgId, new Date());
    await markReminderSent(getDb(), erfolgId, invoiceId);
    await markReminderSent(getDb(), erfolgId, invoiceId);
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ count: invoices.reminderCount, last: invoices.lastReminderSentAt })
        .from(invoices)
        .where(eq(invoices.id, invoiceId)),
    );
    expect(row?.count).toBe(2);
    expect(row?.last).toBeInstanceOf(Date);
  });

  it('processInvoiceReminderTick помечает просроченным и НИЧЕГО НЕ ШЛЁТ', async () => {
    // Раньше этот тест проверял обратное — что тик отправляет письмо. Рассылку
    // выключили по решению владельца (2026-07-23), тик оставлен ради пометки просрочки.
    const { invoiceId } = await setupOverdueInvoice();
    const stats = await processInvoiceReminderTick();

    // Пометка — единственное, что тик теперь делает, и она обязана работать:
    // от статуса «просрочен» зависят дашборд, отчёты и кабинет клиента.
    expect(stats.overdueMarked).toBeGreaterThanOrEqual(1);
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          status: invoices.status,
          count: invoices.reminderCount,
          last: invoices.lastReminderSentAt,
        })
        .from(invoices)
        .where(eq(invoices.id, invoiceId)),
    );
    expect(row?.status).toBe('overdue');

    // Писем нет — при том, что у клиента настоящий адрес и счёт реально просрочен.
    expect(stats.remindersSent).toBe(0);
    expect(sentMail.some((m) => m.to === testEmail)).toBe(false);
    // И счётчик напоминаний не тронут: робот не «израсходовал» напоминание молча,
    // человек по-прежнему может отправить его кнопкой из Дебиторки.
    expect(row?.count).toBe(0);
    expect(row?.last).toBeNull();
  });

  // Здесь были ещё два теста рассылки — «повторный tick не отправляет (cooldown)» и
  // «не отправляет если у клиента нет email». Оба удалены вместе с рассылкой: теперь
  // тик не шлёт НИКОГДА, и такие тесты проходили бы по тривиальной причине, создавая
  // ложное впечатление, что защиты живы. Cooldown ручной кнопки живёт в invoices/service.ts.
});
