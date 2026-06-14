/**
 * Приём входящих (Этап B) — тестируем чистую логику записи без живого IMAP:
 *   • parseTicketNumber — извлечение номера заявки из темы;
 *   • storeInboundMessage — запись входящего (direction='in'), видно в журнале (расшифровано);
 *   • дедуп по messageId;
 *   • привязка к клиенту по e-mail отправителя.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clients, emailMessages, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { parseTicketNumber, storeInboundMessage, type ParsedInbound } from '../modules/email/imap';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let seq = 0;

beforeAll(async () => {
  erfolgId = (await ensureSeed()).erfolgId;
});

afterAll(clearInbound);
beforeEach(clearInbound);

async function clearInbound() {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(emailMessages).where(eq(emailMessages.tenantId, erfolgId)),
  );
}

function inbound(over: Partial<ParsedInbound> = {}): ParsedInbound {
  return {
    from: 'Иван Клиент <ivan@client.ru>',
    fromAddress: 'ivan@client.ru',
    to: 'info@erfolgmt.ru',
    subject: 'Вопрос по технике',
    bodyText: 'Текст входящего письма',
    bodyHtml: null,
    messageId: `<inb-${++seq}@client.ru>`,
    inReplyTo: null,
    references: null,
    date: new Date('2026-06-14T10:00:00.000Z'),
    attachmentName: null,
    attachmentCount: 0,
    attachments: [],
    ...over,
  };
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(): Context {
  const session = {
    tenantId: erfolgId,
    userId: null,
    username: 'director-test',
    role: 'director',
    fullName: 'Test director',
    expiresAt: Date.now() + 3600_000,
  } as unknown as SessionData;
  return {
    db: getDb(),
    tenant: {
      id: erfolgId,
      subdomain: 'erfolg',
      displayName: 'ООО Эрфольг',
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    },
    session,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Context;
}

describe('parseTicketNumber', () => {
  it('находит номер заявки в теме', () => {
    expect(parseTicketNumber('Re: заявка T-2026-000099 готова?')).toBe('T-2026-000099');
    expect(parseTicketNumber('просто тема без номера')).toBeNull();
    expect(parseTicketNumber(null)).toBeNull();
  });
});

describe('storeInboundMessage', () => {
  it('сохраняет входящее — видно в журнале «Входящие» (расшифровано)', async () => {
    const res = await storeInboundMessage(
      getDb(),
      erfolgId,
      inbound({ subject: 'Тестовое входящее', from: 'nobody@x.ru', fromAddress: 'nobody@x.ru' }),
    );
    expect(res.stored).toBe(true);

    const caller = appRouter.createCaller(makeCtx());
    const list = await caller.email.list({ direction: 'in' });
    const row = list.items.find((m) => m.subject === 'Тестовое входящее');
    expect(row).toBeTruthy();
    expect(row?.status).toBe('received');
    expect(row?.from).toBe('nobody@x.ru');
  });

  it('дедуп по messageId — повтор не создаёт дубликат', async () => {
    const p = inbound({ messageId: '<dup-fixed@client.ru>', subject: 'Дубликат' });
    const a = await storeInboundMessage(getDb(), erfolgId, p);
    const b = await storeInboundMessage(getDb(), erfolgId, p);
    expect(a.stored).toBe(true);
    expect(b.stored).toBe(false);
  });

  it('привязывает входящее к клиенту по e-mail отправителя', async () => {
    const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: clients.id, email: clients.email }).from(clients).limit(1),
    );
    if (!c) throw new Error('seed missing client');
    const original = c.email ?? null;
    const email = `inbound-link-${seq}@client.ru`;
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(clients).set({ email }).where(eq(clients.id, c.id)),
    );
    try {
      await storeInboundMessage(
        getDb(),
        erfolgId,
        inbound({ from: email, fromAddress: email, subject: 'Привязка к клиенту' }),
      );
      const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
        tx.select({ rc: emailMessages.relatedClientId }).from(emailMessages),
      );
      expect(rows.some((r) => r.rc === c.id)).toBe(true);
    } finally {
      await withTenantTx(getDb(), erfolgId, (tx) =>
        tx.update(clients).set({ email: original }).where(eq(clients.id, c.id)),
      );
    }
  });
});
