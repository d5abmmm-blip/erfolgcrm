/**
 * Запланированная отправка (раздел «Почта», Этап 2):
 *   • schedule создаёт строку status='scheduled' (видна в папке 'scheduled', не в out/drafts);
 *   • schedule на прошедшее время → BAD_REQUEST;
 *   • cancelSchedule возвращает письмо в черновики;
 *   • processScheduledSend отправляет запланированное и переводит строку в 'sent';
 *   • processScheduledSend идемпотентен: для НЕ-scheduled строки ничего не шлёт;
 *   • sendScheduledNow отправляет немедленно.
 *
 * schedule/cancel/sendNow ходят в Redis (BullMQ) — он поднят в dev и в CI. После прогона
 * чистим очередь (obliterate) и закрываем соединения (shutdownQueues).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { emailMessages, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { __setTransporterForTesting } from '../lib/mailer';
import { getQueue, QUEUE_NAMES, shutdownQueues } from '../lib/queue';
import { processScheduledSend } from '../workers/email-scheduled';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let mid = 0;
const sentMail: Array<{ to: string; subject: string }> = [];

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  __setTransporterForTesting({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMail: vi.fn(async (opts: any) => {
      sentMail.push({ to: opts.to, subject: opts.subject });
      return { messageId: `mock-${++mid}` };
    }),
    close: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

afterAll(async () => {
  __setTransporterForTesting(null);
  await clearMail();
  try {
    await getQueue(QUEUE_NAMES.emailScheduled).obliterate({ force: true });
  } catch {
    /* очередь могла не создаться — не страшно */
  }
  await shutdownQueues();
});

async function clearMail() {
  sentMail.length = 0;
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(emailMessages).where(eq(emailMessages.tenantId, erfolgId)),
  );
}

beforeEach(clearMail);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Context;
}

const future = () => new Date(Date.now() + 60 * 60_000); // +1 час

describe('email отложенная отправка', () => {
  it('schedule создаёт письмо в папке scheduled (не в out/drafts)', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const res = await caller.email.schedule({
      to: 'later@example.com',
      subject: 'Позже',
      bodyText: 'тело',
      scheduledAt: future(),
    });
    expect(res.id).toBeTruthy();

    const scheduled = await caller.email.list({ folder: 'scheduled' });
    expect(scheduled.items.length).toBe(1);
    expect(scheduled.items[0]?.id).toBe(res.id);
    expect(scheduled.items[0]?.status).toBe('scheduled');
    expect(scheduled.items[0]?.scheduledAt).toBeTruthy();

    expect((await caller.email.list({ folder: 'out' })).items.length).toBe(0);
    expect((await caller.email.list({ folder: 'drafts' })).items.length).toBe(0);
    // Письмо ещё не отправлено.
    expect(sentMail.length).toBe(0);
  });

  it('schedule на прошедшее время → BAD_REQUEST', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    try {
      await caller.email.schedule({
        to: 'x@example.com',
        subject: 's',
        bodyText: 'b',
        scheduledAt: new Date(Date.now() - 1000),
      });
      throw new Error('expected BAD_REQUEST');
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe('BAD_REQUEST');
    }
  });

  it('cancelSchedule возвращает письмо в черновики', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const { id } = await caller.email.schedule({
      to: 'c@example.com',
      subject: 'Отменить',
      bodyText: 'тело',
      scheduledAt: future(),
    });
    await caller.email.cancelSchedule({ id });

    expect((await caller.email.list({ folder: 'scheduled' })).items.length).toBe(0);
    const drafts = await caller.email.list({ folder: 'drafts' });
    expect(drafts.items.length).toBe(1);
    expect(drafts.items[0]?.id).toBe(id);
    expect(drafts.items[0]?.status).toBe('draft');
  });

  it('processScheduledSend отправляет запланированное и переводит в sent', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const { id } = await caller.email.schedule({
      to: 'fire@example.com',
      subject: 'Сработает',
      bodyText: 'тело',
      scheduledAt: future(),
    });

    await processScheduledSend({ tenantId: erfolgId, messageId: id });

    expect(sentMail.length).toBe(1);
    expect(sentMail[0]?.to).toBe('fire@example.com');
    expect((await caller.email.list({ folder: 'scheduled' })).items.length).toBe(0);
    const out = await caller.email.list({ folder: 'out' });
    expect(out.items.length).toBe(1);
    expect(out.items[0]?.id).toBe(id);
    expect(out.items[0]?.status).toBe('sent');
  });

  it('processScheduledSend идемпотентен: для черновика (не scheduled) ничего не шлёт', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const { id } = await caller.email.saveDraft({ to: 'd@example.com', subject: 'Черновик', bodyText: 'x' });

    await processScheduledSend({ tenantId: erfolgId, messageId: id });

    expect(sentMail.length).toBe(0);
    // Остался черновиком.
    const drafts = await caller.email.list({ folder: 'drafts' });
    expect(drafts.items.length).toBe(1);
    expect(drafts.items[0]?.id).toBe(id);
  });

  it('sendScheduledNow отправляет немедленно', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const { id } = await caller.email.schedule({
      to: 'now@example.com',
      subject: 'Сейчас',
      bodyText: 'тело',
      scheduledAt: future(),
    });
    const res = await caller.email.sendScheduledNow({ id });
    expect(res.status).toBe('sent');
    expect(sentMail.length).toBe(1);

    expect((await caller.email.list({ folder: 'scheduled' })).items.length).toBe(0);
    const out = await caller.email.list({ folder: 'out' });
    expect(out.items.length).toBe(1);
    expect(out.items[0]?.status).toBe('sent');
  });
});
