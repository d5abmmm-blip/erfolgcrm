/**
 * Этап C — входящие: вложения, спам, чтение.
 *   • storeInboundMessage с 2 вложениями → putBuffer вызван дважды (ключи под
 *     tenants/<id>/email_inbound/email_message/<msgId>/...), 2 строки email_attachments,
 *     email.thread отдаёт вложения с presigned-ссылкой (objectKey наружу не утекает);
 *   • письмо с ***SPAM*** в теме → is_spam, скрыто из list({spam:false}), видно при {spam:true};
 *   • входящее стартует непрочитанным (unreadCount ≥ 1), после markRead счётчик падает.
 *
 * Хранилище подменяем через __setObjectStorageForTesting (реальный S3/local не трогаем).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { emailAttachments, emailMessages, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { storeInboundMessage, type ParsedInbound } from '../modules/email/imap';
import {
  __setObjectStorageForTesting,
  type ObjectStorage,
  type PresignedGet,
} from '../lib/object-storage';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let seq = 0;

interface FakeStorage extends ObjectStorage {
  puts: Array<{ key: string; size: number; mimeType: string }>;
}

function makeFakeStorage(): FakeStorage {
  const puts: Array<{ key: string; size: number; mimeType: string }> = [];
  return {
    puts,
    async presignPut() {
      return { url: 'fake://put', headers: {}, expiresAt: new Date(Date.now() + 60_000) };
    },
    presignGet(key: string): Promise<PresignedGet> {
      return Promise.resolve({ url: `fake://get/${key}`, expiresAt: new Date(Date.now() + 60_000) });
    },
    async putBuffer(key, data, mimeType) {
      puts.push({ key, size: data.length, mimeType });
    },
    async head() {
      return null;
    },
    async remove() {
      return undefined;
    },
  };
}

let fake: FakeStorage;

beforeAll(async () => {
  erfolgId = (await ensureSeed()).erfolgId;
});

beforeEach(async () => {
  fake = makeFakeStorage();
  __setObjectStorageForTesting(fake);
  await clearInbound();
});

afterEach(() => {
  __setObjectStorageForTesting(null);
});

afterAll(clearInbound);

async function clearInbound() {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(emailAttachments).where(eq(emailAttachments.tenantId, erfolgId));
    await tx.delete(emailMessages).where(eq(emailMessages.tenantId, erfolgId));
  });
}

function inbound(over: Partial<ParsedInbound> = {}): ParsedInbound {
  return {
    from: 'Иван Клиент <ivan@client.ru>',
    fromAddress: 'ivan@client.ru',
    to: 'info@erfolgmt.ru',
    subject: 'Вопрос по технике',
    bodyText: 'Текст входящего письма',
    bodyHtml: null,
    messageId: `<inb-att-${++seq}@client.ru>`,
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

describe('входящие — вложения', () => {
  it('2 вложения: putBuffer ×2, 2 строки email_attachments, thread с presigned-ссылкой', async () => {
    const a = Buffer.from('hello-pdf-bytes');
    const b = Buffer.from('photo-bytes-content');
    const parsed = inbound({
      subject: 'Письмо с двумя вложениями',
      messageId: '<att-pair@client.ru>',
      attachmentName: 'act.pdf',
      attachmentCount: 2,
      attachments: [
        { filename: 'act.pdf', content: a, contentType: 'application/pdf', size: a.length },
        { filename: 'photo.jpg', content: b, contentType: 'image/jpeg', size: b.length },
      ],
    });

    const res = await storeInboundMessage(getDb(), erfolgId, parsed);
    expect(res.stored).toBe(true);

    // putBuffer вызван дважды, ключи под нужным префиксом.
    expect(fake.puts.length).toBe(2);
    const prefix = `tenants/${erfolgId}/email_inbound/email_message/`;
    expect(fake.puts.every((p) => p.key.startsWith(prefix))).toBe(true);
    expect(fake.puts.map((p) => p.size).sort()).toEqual([a.length, b.length].sort());

    // 2 строки в email_attachments.
    const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: emailAttachments.id, key: emailAttachments.objectKey }).from(emailAttachments),
    );
    expect(rows.length).toBe(2);

    // email.thread отдаёт вложения с presigned URL; objectKey не светится.
    const caller = appRouter.createCaller(makeCtx());
    const msg = (await caller.email.list({ direction: 'in', search: 'двумя вложениями' })).items[0];
    expect(msg?.hasAttachments).toBe(true);
    const thread = await caller.email.thread({ messageId: String(msg?.id) });
    expect(thread.length).toBe(1);
    const atts = thread[0]?.attachments ?? [];
    expect(atts.length).toBe(2);
    expect(atts.every((x) => x.url.startsWith('fake://get/'))).toBe(true);
    const names = atts.map((x) => x.name).sort();
    expect(names).toEqual(['act.pdf', 'photo.jpg']);
    // DTO вложения не содержит objectKey.
    expect(atts[0]).not.toHaveProperty('objectKey');
  });

  it('битое вложение не теряет письмо и остальные вложения', async () => {
    const ok = Buffer.from('good');
    // Подменяем putBuffer так, чтобы первое вложение падало.
    let n = 0;
    fake.putBuffer = async (key, data, mimeType) => {
      n += 1;
      if (n === 1) throw new Error('boom');
      fake.puts.push({ key, size: data.length, mimeType });
    };
    const parsed = inbound({
      subject: 'Одно битое одно ок',
      messageId: '<att-mixed@client.ru>',
      attachmentCount: 2,
      attachments: [
        { filename: 'bad.bin', content: ok, contentType: 'application/octet-stream', size: ok.length },
        { filename: 'good.txt', content: ok, contentType: 'text/plain', size: ok.length },
      ],
    });
    const res = await storeInboundMessage(getDb(), erfolgId, parsed);
    expect(res.stored).toBe(true); // письмо сохранено

    const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: emailAttachments.id }).from(emailAttachments),
    );
    expect(rows.length).toBe(1); // только успешное вложение
  });
});

describe('входящие — спам', () => {
  it('***SPAM*** помечается is_spam, скрыт из {spam:false}, виден при {spam:true}', async () => {
    await storeInboundMessage(
      getDb(),
      erfolgId,
      inbound({ subject: '***SPAM*** выгодное предложение', messageId: '<spam-1@x.ru>' }),
    );
    await storeInboundMessage(
      getDb(),
      erfolgId,
      inbound({ subject: 'Нормальное письмо', messageId: '<ham-1@x.ru>' }),
    );

    const caller = appRouter.createCaller(makeCtx());
    const notSpam = await caller.email.list({ direction: 'in', spam: false });
    expect(notSpam.items.some((m) => m.subject === '***SPAM*** выгодное предложение')).toBe(false);
    expect(notSpam.items.some((m) => m.subject === 'Нормальное письмо')).toBe(true);

    const onlySpam = await caller.email.list({ direction: 'in', spam: true });
    expect(onlySpam.items.some((m) => m.subject === '***SPAM*** выгодное предложение')).toBe(true);
    expect(onlySpam.items.find((m) => m.subject === '***SPAM*** выгодное предложение')?.isSpam).toBe(true);
  });
});

describe('входящие — чтение', () => {
  it('входящее стартует непрочитанным; после markRead счётчик падает', async () => {
    await storeInboundMessage(
      getDb(),
      erfolgId,
      inbound({ subject: 'Непрочитанное', messageId: '<unread-1@x.ru>' }),
    );
    const caller = appRouter.createCaller(makeCtx());

    const before = await caller.email.unreadCount();
    expect(before).toBeGreaterThanOrEqual(1);

    const msg = (await caller.email.list({ direction: 'in', search: 'Непрочитанное' })).items[0];
    expect(msg?.isRead).toBe(false);

    const r = await caller.email.markRead({ id: String(msg?.id) });
    expect(r.ok).toBe(true);

    const after = await caller.email.unreadCount();
    expect(after).toBe(before - 1);

    const reread = await caller.email.get({ id: String(msg?.id) });
    expect(reread?.isRead).toBe(true);
  });
});
