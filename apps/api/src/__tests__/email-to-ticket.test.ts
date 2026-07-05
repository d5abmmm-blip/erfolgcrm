/**
 * «Заявка из письма» (фича №2). Проверяем БЕЗ живого LLM — на тестовой БД ассистент не
 * настроен, поэтому ИИ-разбор деградирует, а фича продолжает работать детерминированно:
 *   • чистые хелперы разбора (адрес/HTML/симптом/подсказка по технике);
 *   • draftTicketFromEmail: клиент по адресу (привязанный при приёме ИЛИ найденный),
 *     симптом из текста письма, дефолты тип/приоритет, aiUsed=false без LLM;
 *   • linkTicket: письмо привязывается к созданной заявке (relatedTicketId + linkedTicket);
 *   • draftReply: без LLM отдаёт рабочий шаблон;
 *   • cross-tenant: письмо одного tenant не видно из другого (NOT_FOUND).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { clients, emailMessages, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { storeInboundMessage, type ParsedInbound } from '../modules/email/imap';
import {
  buildDeviceHint,
  cleanSymptomFromBody,
  parseEmailAddress,
  REPLY_FALLBACK,
  stripHtmlToText,
} from '../modules/email/ai-draft';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let demoId = '';
let seq = 0;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
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
    subject: 'Не включается аппарат',
    bodyText: 'Здравствуйте! Аппарат УЗИ не включается, чёрный экран. Просьба принять в ремонт.',
    bodyHtml: null,
    messageId: `<e2t-${++seq}@client.ru>`,
    inReplyTo: null,
    references: null,
    date: new Date('2026-07-05T09:00:00.000Z'),
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

function makeCtx(tenantId: string, subdomain: string): Context {
  const session = {
    tenantId,
    userId: null,
    username: 'director-test',
    role: 'director',
    fullName: 'Test director',
    expiresAt: Date.now() + 3600_000,
  } as unknown as SessionData;
  return {
    db: getDb(),
    tenant: {
      id: tenantId,
      subdomain,
      displayName: subdomain === 'erfolg' ? 'ООО Эрфольг' : 'Demo',
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

/** id письма по его messageId (storeInboundMessage не возвращает id). */
async function messageIdByHeader(headerId: string): Promise<string> {
  const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.messageId, headerId)),
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('inbound message not found');
  return id;
}

describe('ai-draft helpers', () => {
  it('parseEmailAddress достаёт голый адрес', () => {
    expect(parseEmailAddress('Иван <ivan@x.ru>')).toBe('ivan@x.ru');
    expect(parseEmailAddress('SNAB@Gorbol.RU')).toBe('snab@gorbol.ru');
    expect(parseEmailAddress('без адреса')).toBeNull();
    expect(parseEmailAddress(null)).toBeNull();
  });

  it('stripHtmlToText снимает теги и сущности', () => {
    expect(stripHtmlToText('<p>Привет<br>мир &amp; всё</p>')).toContain('Привет');
    expect(stripHtmlToText('<div>А</div><div>Б</div>')).toContain('А');
    expect(stripHtmlToText(null)).toBe('');
  });

  it('cleanSymptomFromBody выкидывает цитаты/подпись и обрезает', () => {
    const s = cleanSymptomFromBody(
      'Аппарат не включается.\n> старое письмо\nС уважением, Иван\nтел. 8-999',
      null,
    );
    expect(s).toContain('Аппарат не включается');
    expect(s).not.toContain('старое письмо');
    expect(s).not.toContain('8-999');
    expect(cleanSymptomFromBody('a'.repeat(2000), null, 100).length).toBeLessThanOrEqual(101);
  });

  it('buildDeviceHint собирает читаемую подсказку', () => {
    expect(
      buildDeviceHint({ deviceType: 'УЗИ', manufacturer: 'Mindray', model: 'DC-70', serialNumber: '3F' }),
    ).toBe('УЗИ · Mindray DC-70 · сер. 3F');
    expect(buildDeviceHint({})).toBeNull();
  });
});

describe('email.draftTicketFromEmail (деградация без LLM)', () => {
  it('привязанный при приёме клиент + симптом из тела + дефолты, aiUsed=false', async () => {
    // Ставим известный адрес существующему клиенту, шлём письмо с него → привяжется при приёме.
    const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: clients.id, email: clients.email }).from(clients).limit(1),
    );
    if (!c) throw new Error('seed missing client');
    const email = `draft-link-${seq}@client.ru`;
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(clients).set({ email }).where(eq(clients.id, c.id)),
    );
    const headerId = `<e2t-linked@client.ru>`;
    try {
      await storeInboundMessage(getDb(), erfolgId, inbound({ from: email, fromAddress: email, messageId: headerId }));
      const emailRowId = await messageIdByHeader(headerId);

      const caller = appRouter.createCaller(makeCtx(erfolgId, 'erfolg'));
      const draft = await caller.email.draftTicketFromEmail({ emailId: emailRowId });

      expect(draft.client?.id).toBe(c.id);
      expect(draft.symptom).toContain('не включается');
      expect(draft.repairType).toBe('paid');
      expect(draft.priority).toBe('normal');
      expect(draft.device).toBeNull();
      expect(draft.aiUsed).toBe(false);
      expect(draft.linkedTicket).toBeNull();
    } finally {
      await withTenantTx(getDb(), erfolgId, (tx) =>
        tx.update(clients).set({ email: c.email ?? null }).where(eq(clients.id, c.id)),
      );
    }
  });

  it('находит клиента по адресу, даже если письмо ещё не привязано', async () => {
    const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: clients.id, email: clients.email }).from(clients).limit(1),
    );
    if (!c) throw new Error('seed missing client');
    const email = `draft-rematch-${seq}@client.ru`;
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(clients).set({ email }).where(eq(clients.id, c.id)),
    );
    const headerId = `<e2t-rematch@client.ru>`;
    try {
      await storeInboundMessage(getDb(), erfolgId, inbound({ from: email, fromAddress: email, messageId: headerId }));
      const emailRowId = await messageIdByHeader(headerId);
      // Сбрасываем привязку → сервер должен заново найти клиента по адресу отправителя.
      await withTenantTx(getDb(), erfolgId, (tx) =>
        tx.update(emailMessages).set({ relatedClientId: null }).where(eq(emailMessages.id, emailRowId)),
      );

      const caller = appRouter.createCaller(makeCtx(erfolgId, 'erfolg'));
      const draft = await caller.email.draftTicketFromEmail({ emailId: emailRowId });
      expect(draft.client?.id).toBe(c.id);
    } finally {
      await withTenantTx(getDb(), erfolgId, (tx) =>
        tx.update(clients).set({ email: c.email ?? null }).where(eq(clients.id, c.id)),
      );
    }
  });

  it('неизвестный отправитель → клиент не найден, симптом всё равно из письма', async () => {
    const headerId = `<e2t-unknown@nowhere.ru>`;
    await storeInboundMessage(
      getDb(),
      erfolgId,
      inbound({ from: 'stranger@nowhere.ru', fromAddress: 'stranger@nowhere.ru', messageId: headerId }),
    );
    const emailRowId = await messageIdByHeader(headerId);
    const caller = appRouter.createCaller(makeCtx(erfolgId, 'erfolg'));
    const draft = await caller.email.draftTicketFromEmail({ emailId: emailRowId });
    expect(draft.client).toBeNull();
    expect(draft.symptom.length).toBeGreaterThan(0);
  });
});

describe('email.linkTicket', () => {
  it('привязывает письмо к заявке → relatedTicketId и linkedTicket в черновике', async () => {
    const caller = appRouter.createCaller(makeCtx(erfolgId, 'erfolg'));
    // Небюджетный клиент — заявке не нужен контракт.
    const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ id: clients.id })
        .from(clients)
        .where(sql`subtype IS DISTINCT FROM 'budget'`)
        .limit(1),
    );
    if (!c) throw new Error('seed missing non-budget client');
    const ticket = await caller.tickets.create({ clientId: c.id, symptom: 'Тест связи письма' });

    const headerId = `<e2t-link@client.ru>`;
    await storeInboundMessage(getDb(), erfolgId, inbound({ messageId: headerId }));
    const emailRowId = await messageIdByHeader(headerId);

    const res = await caller.email.linkTicket({ emailId: emailRowId, ticketId: ticket.id });
    expect(res.ok).toBe(true);

    const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ rt: emailMessages.relatedTicketId }).from(emailMessages).where(eq(emailMessages.id, emailRowId)),
    );
    expect(rows[0]?.rt).toBe(ticket.id);

    const draft = await caller.email.draftTicketFromEmail({ emailId: emailRowId });
    expect(draft.linkedTicket?.id).toBe(ticket.id);
    expect(draft.linkedTicket?.number).toBe(ticket.ticketNumber);
  });
});

describe('email.linkTicket защита от чужой заявки', () => {
  it('привязка к несуществующей/невидимой заявке → NOT_FOUND', async () => {
    const caller = appRouter.createCaller(makeCtx(erfolgId, 'erfolg'));
    const headerId = `<e2t-linkguard@client.ru>`;
    await storeInboundMessage(getDb(), erfolgId, inbound({ messageId: headerId }));
    const emailRowId = await messageIdByHeader(headerId);
    // Случайный uuid — как заявка другого тенанта: RLS скрывает её → NOT_FOUND.
    await expect(
      caller.email.linkTicket({
        emailId: emailRowId,
        ticketId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/не найдена|NOT_FOUND/i);
  });

  it('demo не может привязать своё письмо к заявке erfolg (cross-tenant)', async () => {
    const erfolgCaller = appRouter.createCaller(makeCtx(erfolgId, 'erfolg'));
    const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ id: clients.id })
        .from(clients)
        .where(sql`subtype IS DISTINCT FROM 'budget'`)
        .limit(1),
    );
    if (!c) throw new Error('seed missing non-budget client');
    const ticket = await erfolgCaller.tickets.create({ clientId: c.id, symptom: 'Заявка erfolg' });

    const headerId = `<e2t-xt-link@demo.ru>`;
    await storeInboundMessage(getDb(), demoId, inbound({ messageId: headerId }));
    const demoRows = await withTenantTx(getDb(), demoId, (tx) =>
      tx.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.messageId, headerId)),
    );
    const demoEmailId = demoRows[0]?.id;
    if (!demoEmailId) throw new Error('demo inbound not stored');
    const demoCaller = appRouter.createCaller(makeCtx(demoId, 'demo'));
    try {
      await expect(
        demoCaller.email.linkTicket({ emailId: demoEmailId, ticketId: ticket.id }),
      ).rejects.toThrow(/не найдена|NOT_FOUND/i);
      // И письмо demo НЕ должно получить чужой relatedTicketId.
      const check = await withTenantTx(getDb(), demoId, (tx) =>
        tx
          .select({ rt: emailMessages.relatedTicketId })
          .from(emailMessages)
          .where(eq(emailMessages.id, demoEmailId)),
      );
      expect(check[0]?.rt ?? null).toBeNull();
    } finally {
      await withTenantTx(getDb(), demoId, (tx) =>
        tx.delete(emailMessages).where(eq(emailMessages.id, demoEmailId)),
      );
    }
  });
});

describe('email.draftReply (деградация без LLM)', () => {
  it('без LLM отдаёт рабочий шаблон ответа, aiUsed=false', async () => {
    const headerId = `<e2t-reply@client.ru>`;
    await storeInboundMessage(getDb(), erfolgId, inbound({ messageId: headerId }));
    const emailRowId = await messageIdByHeader(headerId);
    const caller = appRouter.createCaller(makeCtx(erfolgId, 'erfolg'));
    const reply = await caller.email.draftReply({ emailId: emailRowId });
    expect(reply.aiUsed).toBe(false);
    expect(reply.text).toBe(REPLY_FALLBACK);
    expect(reply.text.toLowerCase()).toContain('заявк');
  });
});

describe('email.draftTicketFromEmail cross-tenant', () => {
  it('письмо erfolg не видно из demo → NOT_FOUND', async () => {
    const headerId = `<e2t-xt@client.ru>`;
    await storeInboundMessage(getDb(), erfolgId, inbound({ messageId: headerId }));
    const emailRowId = await messageIdByHeader(headerId);
    const demoCaller = appRouter.createCaller(makeCtx(demoId, 'demo'));
    await expect(demoCaller.email.draftTicketFromEmail({ emailId: emailRowId })).rejects.toThrow(
      /не найдено|NOT_FOUND/i,
    );
  });
});
