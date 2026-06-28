/**
 * Тесты email-уведомлений клиента при смене статуса заявки.
 *
 * Покрытие:
 *   • shouldNotifyClient — фильтр статусов (act_pending → шлём, approval → skip).
 *   • renderTicketStatusEmail — subject/text для act_pending.
 *   • processTicketStatusNotify — реально шлёт письмо (через мок mailer)
 *     и пропускает: (a) approval, (b) клиент без email, (c) ticket not found.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, tenants, tickets, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { __setTransporterForTesting } from '../lib/mailer';
import {
  processTicketStatusNotify,
  type TicketStatusNotifyPayload,
} from '../workers/ticket-status-notify';
import {
  renderTicketStatusEmail,
  shouldNotifyClient,
} from '../lib/email-templates/ticket-status';

let erfolgId = '';
let primaryClientId = '';
let originalEmail: string | null = null;

const TEST_PREFIX = 'TESTNOTIFY-';

const sentMail: Array<{ to: string; subject: string; text?: string; html?: string }> = [];

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id, email: clients.email }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
  originalEmail = c.email ?? null;
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx
      .update(clients)
      .set({ email: 'notify-target@example.com' })
      .where(eq(clients.id, primaryClientId));
  });

  // Фича B — уведомление «готово» (act_pending) опт-ин, по умолчанию ВКЛЮЧЕНО
  // (DB DEFAULT true). Явно выставляем true для детерминизма тестов отправки.
  // tenants — control-plane без RLS.
  await getDb()
    .update(tenants)
    .set({ notifyClientWhenReady: true })
    .where(eq(tenants.id, erfolgId));

  __setTransporterForTesting({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMail: vi.fn(async (opts: any) => {
      sentMail.push({ to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
      return { messageId: `mock-${Date.now()}` };
    }),
    close: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

afterAll(async () => {
  __setTransporterForTesting(null);
  // вернём исходный email, чтобы не ломать соседние тесты
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.update(clients).set({ email: originalEmail }).where(eq(clients.id, primaryClientId));
  });
  // Фича B — вернём опт-ин в дефолтное (ВКЛЮЧЕНО) состояние.
  await getDb()
    .update(tenants)
    .set({ notifyClientWhenReady: true })
    .where(eq(tenants.id, erfolgId));
});

async function clearTestData(): Promise<void> {
  sentMail.length = 0;
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}

async function createTestTicket(): Promise<{ id: string; ticketNumber: string }> {
  const t = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}status-flow`,
  });
  return { id: t.id, ticketNumber: t.ticketNumber };
}

describe('shouldNotifyClient', () => {
  it('возвращает true для act_pending и closed', () => {
    expect(shouldNotifyClient('act_pending')).toBe(true);
    expect(shouldNotifyClient('closed')).toBe(true);
    expect(shouldNotifyClient('cancelled')).toBe(true);
  });
  it('возвращает false для approval (транзитный — skip)', () => {
    expect(shouldNotifyClient('approval')).toBe(false);
  });
});

describe('renderTicketStatusEmail', () => {
  it('формирует subject и текст для act_pending', () => {
    const out = renderTicketStatusEmail({
      ticketNumber: 'T-2026-000099',
      newStatus: 'act_pending',
      clientDisplayName: 'ООО Тест',
      assetModel: 'УЗИ Mindray DC-70',
      symptom: 'Не включается',
      engineerFullName: 'Иванов И.И.',
      cancelReason: null,
      tenantDisplayName: 'ООО Эрфольг',
    });
    expect(out.subject).toBe('Заявка №T-2026-000099 — Готова к выдаче');
    expect(out.text).toContain('Здравствуйте, ООО Тест');
    expect(out.text).toContain('Готова к выдаче');
    expect(out.text).toContain('УЗИ Mindray DC-70');
    expect(out.text).toContain('Иванов И.И.');
    expect(out.html).toContain('ООО Эрфольг');
    expect(out.html).toContain('Готова к выдаче');
  });

  it('включает причину отмены для cancelled', () => {
    const out = renderTicketStatusEmail({
      ticketNumber: 'T-2026-000100',
      newStatus: 'cancelled',
      clientDisplayName: 'Иванов И.И.',
      assetModel: null,
      symptom: null,
      engineerFullName: null,
      cancelReason: 'Клиент отказался',
      tenantDisplayName: 'ООО Эрфольг',
    });
    expect(out.subject).toContain('отменена');
    expect(out.text).toContain('Клиент отказался');
    expect(out.text).toContain('не назначен');
  });
});

describe('processTicketStatusNotify (worker)', () => {
  beforeEach(clearTestData);

  it('act_pending → отправляет письмо клиенту', async () => {
    const { id, ticketNumber } = await createTestTicket();
    const payload: TicketStatusNotifyPayload = {
      tenantId: erfolgId,
      ticketId: id,
      oldStatus: 'in_progress',
      newStatus: 'act_pending',
    };
    const result = await processTicketStatusNotify(payload);
    expect(result.status).toBe('sent');
    expect(sentMail.length).toBe(1);
    const sent = sentMail[0]!;
    expect(sent.to).toBe('notify-target@example.com');
    expect(sent.subject).toContain(ticketNumber);
    expect(sent.subject).toContain('Готова к выдаче');
    expect(sent.html).toContain('Эрфольг');
  });

  it('approval → skipped, письмо не отправляется', async () => {
    const { id } = await createTestTicket();
    const result = await processTicketStatusNotify({
      tenantId: erfolgId,
      ticketId: id,
      oldStatus: 'estimate',
      newStatus: 'approval',
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('status-not-notifiable');
    expect(sentMail.length).toBe(0);
  });

  it('skipped если у клиента нет email', async () => {
    const { id } = await createTestTicket();
    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx.update(clients).set({ email: null }).where(eq(clients.id, primaryClientId));
    });
    const result = await processTicketStatusNotify({
      tenantId: erfolgId,
      ticketId: id,
      oldStatus: 'in_progress',
      newStatus: 'act_pending',
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no-email');
    expect(sentMail.length).toBe(0);
    // restore email для последующих тестов
    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx
        .update(clients)
        .set({ email: 'notify-target@example.com' })
        .where(eq(clients.id, primaryClientId));
    });
  });

  it('skipped если ticket не найден', async () => {
    const result = await processTicketStatusNotify({
      tenantId: erfolgId,
      ticketId: '00000000-0000-0000-0000-000000000000',
      oldStatus: 'in_progress',
      newStatus: 'act_pending',
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('ticket-not-found');
    expect(sentMail.length).toBe(0);
  });

  it('closed → отправляет письмо', async () => {
    const { id } = await createTestTicket();
    const result = await processTicketStatusNotify({
      tenantId: erfolgId,
      ticketId: id,
      oldStatus: 'act_pending',
      newStatus: 'closed',
    });
    expect(result.status).toBe('sent');
    expect(sentMail[0]?.subject).toContain('закрыта');
  });

  it('Фича B: act_pending при выключенном опт-ине — skipped, письмо не шлём', async () => {
    const { id } = await createTestTicket();
    // временно выключаем опт-ин
    await getDb()
      .update(tenants)
      .set({ notifyClientWhenReady: false })
      .where(eq(tenants.id, erfolgId));
    try {
      const result = await processTicketStatusNotify({
        tenantId: erfolgId,
        ticketId: id,
        oldStatus: 'in_progress',
        newStatus: 'act_pending',
      });
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('ready-notify-disabled');
      expect(sentMail.length).toBe(0);
    } finally {
      await getDb()
        .update(tenants)
        .set({ notifyClientWhenReady: true })
        .where(eq(tenants.id, erfolgId));
    }
  });

  it('Фича B: act_pending шлём один раз (идемпотентность по ready_notified_at)', async () => {
    const { id } = await createTestTicket();
    const payload: TicketStatusNotifyPayload = {
      tenantId: erfolgId,
      ticketId: id,
      oldStatus: 'in_progress',
      newStatus: 'act_pending',
    };
    const first = await processTicketStatusNotify(payload);
    expect(first.status).toBe('sent');
    expect(sentMail.length).toBe(1);

    // повторный переход в act_pending (например после возврата на доделку) — не дублируем
    const second = await processTicketStatusNotify(payload);
    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('ready-already-notified');
    expect(sentMail.length).toBe(1);
  });
});
