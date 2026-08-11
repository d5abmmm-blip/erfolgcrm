/**
 * Курсор IMAP (imapLastUid) не должен переезжать через письмо, которое не
 * удалось разобрать или сохранить.
 *
 * Раньше maxUid двигался на КАЖДОМ письме независимо от исхода parseAndStore
 * (сбой глотался с warn) — и письмо клиента, упавшее при разборе, пропадало
 * НАВСЕГДА: следующий тик начинал уже после него.
 *
 * Теперь курсор двигается только по непрерывной цепочке успешно обработанных
 * писем: первый сбой «замораживает» его, следующий тик перечитывает упавшее
 * письмо ещё раз, а уже сохранённые соседи отфильтровываются дедупом по
 * Message-ID (storeInboundMessage возвращает duplicate, не дубль в базе).
 *
 * IMAP и MIME-разбор замоканы (vi.mock imapflow/mailparser), БД — настоящая.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { emailConfigs, emailMessages, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { fetchInbox } from '../modules/email/imap';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

/** Письма «на сервере» и рубильник поломки разбора — общие с фабриками моков. */
const h = vi.hoisted(() => ({
  letters: [] as Array<{ uid: number; source: Buffer }>,
  parserBreaks: true,
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { exists: 0 };
    constructor() {
      this.mailbox = { exists: h.letters.length };
    }
    on(): void {}
    async connect(): Promise<void> {}
    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release: () => undefined };
    }
    async *fetch(range: string): AsyncGenerator<{ uid: number; source: Buffer }> {
      const from = Number(/^(\d+):\*$/.exec(range)?.[1] ?? '1');
      for (const l of h.letters) {
        // Как настоящий сервер: N:* отдаёт письма с uid >= N (и как минимум последнее).
        if (l.uid >= from || l === h.letters[h.letters.length - 1]) yield l;
      }
    }
    async logout(): Promise<void> {}
  },
}));

vi.mock('mailparser', () => ({
  simpleParser: async (src: Buffer) => {
    const text = src.toString();
    const uid = /UID=(\d+)/.exec(text)?.[1] ?? '0';
    if (text.includes('BROKEN') && h.parserBreaks) {
      throw new Error('boom: mime parse failed');
    }
    return {
      subject: `Письмо ${uid}`,
      text: `тело ${uid}`,
      messageId: `<m${uid}@cursor.test>`,
      attachments: [],
    };
  },
}));

let erfolgId = '';

function makeLetter(uid: number, broken = false): { uid: number; source: Buffer } {
  return { uid, source: Buffer.from(`UID=${uid}${broken ? ' BROKEN' : ''}`) };
}

function directorCtx(): Context {
  const session: SessionData = {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Context;
}

async function setLastUid(uid: number): Promise<void> {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.update(emailConfigs).set({ imapLastUid: uid }).where(eq(emailConfigs.tenantId, erfolgId)),
  );
}

async function getLastUid(): Promise<number> {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ lastUid: emailConfigs.imapLastUid })
      .from(emailConfigs)
      .where(eq(emailConfigs.tenantId, erfolgId)),
  );
  return row?.lastUid ?? -1;
}

async function countByMessageId(messageId: string): Promise<number> {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(emailMessages)
      .where(eq(emailMessages.messageId, messageId)),
  );
  return row?.n ?? 0;
}

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  // IMAP-реквизиты ящика (пароль шифруется в setConfig, fetchInbox его расшифрует).
  await appRouter.createCaller(directorCtx()).email.setConfig({
    enabled: true,
    fromName: 'Тест',
    fromEmail: 'inbox@example.ru',
    smtpHost: 'smtp.example.ru',
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: 'inbox@example.ru',
    smtpPassword: 'smtp-pw',
    imapHost: 'imap.example.ru',
    imapPort: 993,
    imapSecure: true,
    imapUser: 'inbox@example.ru',
    imapPassword: 'imap-pw',
    signature: null,
  });
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(emailMessages).where(like(emailMessages.messageId, '%@cursor.test%')),
  );
  h.letters.length = 0;
  h.parserBreaks = true;
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(emailMessages).where(like(emailMessages.messageId, '%@cursor.test%')),
  );
});

describe('IMAP-курсор при сбое разбора письма', () => {
  it('сбойное письмо не теряется: курсор замирает перед ним, следующий тик дочитывает без дублей', async () => {
    await setLastUid(100);
    h.letters.push(makeLetter(101), makeLetter(102, true), makeLetter(103));

    // Тик 1: письмо 102 падает при разборе.
    const first = await fetchInbox(getDb(), erfolgId);
    expect(first.fetched).toBe(2); // 101 и 103 сохранены
    expect(await countByMessageId('<m101@cursor.test>')).toBe(1);
    expect(await countByMessageId('<m103@cursor.test>')).toBe(1);
    // Ядро находки: курсор НЕ переехал через упавшее письмо — остановился на
    // последнем успешном ДО него (101), чтобы следующий тик начал ровно со 102.
    // (До правки здесь было 103 — письмо 102 пропадало навсегда.)
    expect(await getLastUid()).toBe(101);

    // Тик 2: разбор «починился» (например, временный сбой БД/хранилища прошёл).
    h.parserBreaks = false;
    const second = await fetchInbox(getDb(), erfolgId);
    expect(second.fetched).toBe(1); // дочитано ровно упавшее письмо
    expect(await countByMessageId('<m102@cursor.test>')).toBe(1);
    // Соседи не задвоились (дедуп по Message-ID).
    expect(await countByMessageId('<m101@cursor.test>')).toBe(1);
    expect(await countByMessageId('<m103@cursor.test>')).toBe(1);
    // Теперь курсор дошёл до конца.
    expect(await getLastUid()).toBe(103);
  });

  it('без сбоев курсор двигается как раньше', async () => {
    await setLastUid(100);
    h.parserBreaks = false;
    h.letters.push(makeLetter(101), makeLetter(102), makeLetter(103));

    const res = await fetchInbox(getDb(), erfolgId);
    expect(res.fetched).toBe(3);
    expect(await getLastUid()).toBe(103);
  });
});
