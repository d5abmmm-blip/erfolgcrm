/**
 * Этап C — треды почты:
 *   • юнит-тесты чистых помощников thread.ts (computeThreadId / normalizeReferences / isSpamSubject);
 *   • интеграция: исходное письмо + ответ (inReplyTo + references) делят общий threadId,
 *     email.thread возвращает оба письма от старых к новым.
 *
 * Отправка — через инъектированный тест-транспорт (реальный SMTP не дёргается).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { emailMessages, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { __setTransporterForTesting } from '../lib/mailer';
import { computeThreadId, isSpamSubject, normalizeReferences } from '../modules/email/thread';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let mid = 0;

beforeAll(async () => {
  erfolgId = (await ensureSeed()).erfolgId;
  __setTransporterForTesting({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMail: vi.fn(async (_opts: any) => ({ messageId: `<mock-${++mid}@erfolgmt.ru>` })),
    close: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

afterAll(async () => {
  __setTransporterForTesting(null);
  await clearMail();
});

async function clearMail() {
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

describe('thread helpers (unit)', () => {
  it('computeThreadId: references[0] выигрывает', () => {
    expect(computeThreadId('<b@x>', '<root@x> <b@x>', '<self@x>')).toBe('<root@x>');
  });
  it('computeThreadId: падает на inReplyTo, затем на свой messageId', () => {
    expect(computeThreadId('<parent@x>', null, '<self@x>')).toBe('<parent@x>');
    expect(computeThreadId(null, null, '<self@x>')).toBe('<self@x>');
  });
  it('computeThreadId: всё пусто → null', () => {
    expect(computeThreadId(null, null, null)).toBeNull();
    expect(computeThreadId(null, '   ', null)).toBeNull();
  });

  it('normalizeReferences: массив → строка через пробел', () => {
    expect(normalizeReferences(['<a@x>', '<b@x>'])).toBe('<a@x> <b@x>');
  });
  it('normalizeReferences: строка проходит как есть (trim)', () => {
    expect(normalizeReferences('  <a@x> <b@x>  ')).toBe('<a@x> <b@x>');
  });
  it('normalizeReferences: пусто → null', () => {
    expect(normalizeReferences([])).toBeNull();
    expect(normalizeReferences('')).toBeNull();
    expect(normalizeReferences(null)).toBeNull();
    expect(normalizeReferences(undefined)).toBeNull();
  });

  it('isSpamSubject: ловит ***SPAM*** без учёта регистра', () => {
    expect(isSpamSubject('***SPAM*** дешёвые часы')).toBe(true);
    expect(isSpamSubject('Re: *** spam *** offer')).toBe(true);
    expect(isSpamSubject('обычная тема')).toBe(false);
    expect(isSpamSubject(null)).toBe(false);
  });
});

describe('email.thread (integration)', () => {
  it('исходное письмо и ответ делят threadId; thread отдаёт оба (старые→новые)', async () => {
    const caller = appRouter.createCaller(makeCtx());

    // 1) Исходное письмо.
    await caller.email.send({ to: 'client@x.ru', subject: 'Тред старт', bodyText: 'первое' });
    const first = (await caller.email.list({ search: 'Тред старт' })).items[0];
    expect(first).toBeTruthy();
    const full = await caller.email.get({ id: String(first?.id) });
    const rootMsgId = full?.messageId;
    expect(rootMsgId).toBeTruthy();
    expect(full?.threadId).toBe(rootMsgId); // у первого threadId = собственный Message-ID

    // 2) Ответ в треде: inReplyTo + references указывают на первое письмо.
    await caller.email.send({
      to: 'client@x.ru',
      subject: 'Re: Тред старт',
      bodyText: 'ответ',
      inReplyTo: String(rootMsgId),
      references: [String(rootMsgId)],
    });
    const reply = (await caller.email.list({ search: 'Re: Тред старт' })).items[0];
    const replyFull = await caller.email.get({ id: String(reply?.id) });
    expect(replyFull?.threadId).toBe(rootMsgId); // тот же тред
    expect(replyFull?.inReplyTo).toBe(rootMsgId);
    expect(replyFull?.references).toBe(rootMsgId);

    // 3) thread по любому письму возвращает оба, от старых к новым.
    const thread = await caller.email.thread({ messageId: String(reply?.id) });
    expect(thread.length).toBe(2);
    expect(thread[0]?.subject).toBe('Тред старт');
    expect(thread[1]?.subject).toBe('Re: Тред старт');
    expect(thread[0]?.attachments).toEqual([]);
  });

  it('письмо без треда: thread возвращает только его самого', async () => {
    const caller = appRouter.createCaller(makeCtx());
    await caller.email.send({ to: 'solo@x.ru', subject: 'Одиночка', bodyText: 'x' });
    const m = (await caller.email.list({ search: 'Одиночка' })).items[0];
    const thread = await caller.email.thread({ messageId: String(m?.id) });
    expect(thread.length).toBe(1);
    expect(thread[0]?.subject).toBe('Одиночка');
  });
});
