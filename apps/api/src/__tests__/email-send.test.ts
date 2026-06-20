/**
 * email.send / email.list (раздел «Почта», отправка + журнал):
 *   • staff отправляет → статус 'sent', строка появляется в журнале (тема/адрес расшифрованы);
 *   • вложение фиксируется метаданными в журнале;
 *   • dispatcher тоже может (staff), engineer → FORBIDDEN, anonymous → UNAUTHORIZED.
 *
 * Отправка идёт через инъектированный тест-транспорт (__setTransporterForTesting),
 * реальный SMTP не дёргается.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { emailMessages, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { __setTransporterForTesting } from '../lib/mailer';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let mid = 0;
const sentMail: Array<{
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: unknown;
}> = [];

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  __setTransporterForTesting({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMail: vi.fn(async (opts: any) => {
      sentMail.push({
        to: opts.to,
        cc: opts.cc,
        bcc: opts.bcc,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
        attachments: opts.attachments,
      });
      return { messageId: `mock-${++mid}` };
    }),
    close: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

afterAll(async () => {
  __setTransporterForTesting(null);
  await clearMail();
});

async function clearMail() {
  sentMail.length = 0;
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(emailMessages).where(eq(emailMessages.tenantId, erfolgId)),
  );
}

beforeEach(clearMail);

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(role: 'director' | 'dispatcher' | 'engineer' | 'anonymous'): Context {
  let session: SessionData | null = null;
  if (role !== 'anonymous') {
    session = {
      tenantId: erfolgId,
      userId: null,
      username: `${role}-test`,
      role,
      fullName: `Test ${role}`,
      expiresAt: Date.now() + 3600_000,
    } as unknown as SessionData;
  }
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

async function expectError(promise: Promise<unknown>, code: 'FORBIDDEN' | 'UNAUTHORIZED') {
  try {
    await promise;
    throw new Error(`expected ${code}, but call succeeded`);
  } catch (err) {
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe(code);
  }
}

describe('email.send + journal', () => {
  it('staff отправляет — статус sent, письмо в журнале (расшифровано)', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const res = await caller.email.send({
      to: 'mailtest@example.com',
      subject: 'Тестовая тема',
      bodyText: 'Тело письма',
    });
    expect(res.status).toBe('sent');
    expect(sentMail.length).toBe(1);
    expect(sentMail[0]?.to).toBe('mailtest@example.com');

    const list = await caller.email.list({});
    const row = list.items.find((m) => m.subject === 'Тестовая тема');
    expect(row).toBeTruthy();
    expect(row?.to).toBe('mailtest@example.com');
    expect(row?.status).toBe('sent');
  });

  it('вложение фиксируется в журнале метаданными', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    await caller.email.send({
      to: 'mailtest2@example.com',
      subject: 'С вложением',
      bodyText: 'тело',
      attachment: { filename: 'Счёт.pdf', base64: 'JVBERi0=', kind: 'invoice' },
    });
    expect(sentMail[0]?.attachments).toBeTruthy();

    const list = await caller.email.list({});
    const row = list.items.find((m) => m.subject === 'С вложением');
    expect(row?.attachmentName).toBe('Счёт.pdf');
    expect(row?.attachmentKind).toBe('invoice');
  });

  it('поиск по теме находит письмо', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    await caller.email.send({ to: 'find@example.com', subject: 'УникальнаяТема42', bodyText: 'x' });
    const list = await caller.email.list({ search: 'УникальнаяТема42' });
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.subject).toBe('УникальнаяТема42');
  });

  it('email.get отдаёт письмо целиком с расшифрованным телом', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    await caller.email.send({
      to: 'getone@example.com',
      subject: 'Тело внутри',
      bodyText: 'Секретный текст письма',
    });
    const list = await caller.email.list({ search: 'Тело внутри' });
    const id = list.items[0]?.id;
    expect(id).toBeTruthy();
    const full = await caller.email.get({ id: String(id) });
    expect(full?.subject).toBe('Тело внутри');
    expect(full?.bodyText).toBe('Секретный текст письма');
    expect(full?.to).toBe('getone@example.com');
  });

  it('cc/bcc уходят в SMTP и сохраняются в журнале (расшифровка)', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    await caller.email.send({
      to: 'main@example.com',
      cc: 'copy@example.com',
      bcc: 'secret@example.com',
      subject: 'С копиями',
      bodyText: 'тело',
    });
    expect(sentMail[0]?.cc).toBe('copy@example.com');
    expect(sentMail[0]?.bcc).toBe('secret@example.com');

    const list = await caller.email.list({ search: 'С копиями' });
    const id = list.items[0]?.id;
    const full = await caller.email.get({ id: String(id) });
    expect(full?.cc).toBe('copy@example.com');
    expect(full?.bcc).toBe('secret@example.com');
  });

  it('dispatcher тоже может отправлять (staff)', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const res = await caller.email.send({
      to: 'mailtest3@example.com',
      subject: 'От диспетчера',
      bodyText: 'тело',
    });
    expect(res.status).toBe('sent');
  });

  it('engineer → FORBIDDEN на отправку', async () => {
    const caller = appRouter.createCaller(makeCtx('engineer'));
    await expectError(
      caller.email.send({ to: 'x@example.com', subject: 's', bodyText: 'b' }),
      'FORBIDDEN',
    );
  });

  it('anonymous → UNAUTHORIZED на журнал', async () => {
    const caller = appRouter.createCaller(makeCtx('anonymous'));
    await expectError(caller.email.list({}), 'UNAUTHORIZED');
  });
});
