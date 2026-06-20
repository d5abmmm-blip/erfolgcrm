/**
 * Корзина (раздел «Почта», Этап 3):
 *   • trash убирает письмо из обычной папки в «Корзину» (мягкое удаление);
 *   • restore возвращает письмо обратно;
 *   • purge удаляет навсегда — только из корзины (иначе BAD_REQUEST);
 *   • trash запланированного убирает его из «Запланированных».
 *
 * trash/restore/purge снимают возможную BullMQ-задачу (Redis поднят в dev/CI) —
 * после прогона чистим очередь и закрываем соединения.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { emailMessages, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { __setTransporterForTesting } from '../lib/mailer';
import { getQueue, QUEUE_NAMES, shutdownQueues } from '../lib/queue';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let mid = 0;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  __setTransporterForTesting({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMail: vi.fn(async (_opts: any) => ({ messageId: `mock-${++mid}` })),
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
    /* очередь могла не создаться */
  }
  await shutdownQueues();
});

async function clearMail() {
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

async function sendOne(caller: ReturnType<typeof appRouter.createCaller>, subject: string) {
  await caller.email.send({ to: 'trash-test@example.com', subject, bodyText: 'тело' });
  const out = await caller.email.list({ folder: 'out' });
  const row = out.items.find((m) => m.subject === subject);
  if (!row) throw new Error('sent message not found');
  return row.id;
}

describe('email корзина', () => {
  it('trash убирает письмо из Отправленных в Корзину', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const id = await sendOne(caller, 'В корзину');
    await caller.email.trash({ id });

    expect((await caller.email.list({ folder: 'out' })).items.length).toBe(0);
    const trash = await caller.email.list({ folder: 'trash' });
    expect(trash.items.length).toBe(1);
    expect(trash.items[0]?.id).toBe(id);
  });

  it('restore возвращает письмо из Корзины', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const id = await sendOne(caller, 'Вернуть');
    await caller.email.trash({ id });
    await caller.email.restore({ id });

    expect((await caller.email.list({ folder: 'trash' })).items.length).toBe(0);
    const out = await caller.email.list({ folder: 'out' });
    expect(out.items.length).toBe(1);
    expect(out.items[0]?.id).toBe(id);
  });

  it('purge удаляет навсегда (из корзины)', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const id = await sendOne(caller, 'Навсегда');
    await caller.email.trash({ id });
    await caller.email.purge({ id });

    expect((await caller.email.list({ folder: 'trash' })).items.length).toBe(0);
    expect((await caller.email.list({ folder: 'out' })).items.length).toBe(0);
    expect(await caller.email.get({ id })).toBeNull();
  });

  it('purge вне корзины → BAD_REQUEST', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const id = await sendOne(caller, 'НеУдалять');
    try {
      await caller.email.purge({ id });
      throw new Error('expected BAD_REQUEST');
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe('BAD_REQUEST');
    }
    // Письмо на месте.
    expect((await caller.email.list({ folder: 'out' })).items.length).toBe(1);
  });

  it('trash запланированного убирает его из Запланированных', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const { id } = await caller.email.schedule({
      to: 'sch@example.com',
      subject: 'Запл. в корзину',
      bodyText: 'тело',
      scheduledAt: new Date(Date.now() + 60 * 60_000),
    });
    await caller.email.trash({ id });

    expect((await caller.email.list({ folder: 'scheduled' })).items.length).toBe(0);
    const trash = await caller.email.list({ folder: 'trash' });
    expect(trash.items.some((m) => m.id === id)).toBe(true);
  });
});
