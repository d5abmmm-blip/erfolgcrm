/**
 * email.saveDraft / отправка из черновика (раздел «Почта», Этап 1 — черновики):
 *   • saveDraft создаёт черновик → виден в папке 'drafts' (расшифрован), но НЕ в 'out';
 *   • saveDraft с id обновляет ту же строку (без дубля);
 *   • частичный черновик (только тема, без адреса) сохраняется;
 *   • send с fromDraftId переводит ТУ ЖЕ строку в 'sent' (не плодит дубль);
 *   • engineer → FORBIDDEN.
 *
 * Отправка идёт через инъектированный тест-транспорт (__setTransporterForTesting).
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

async function expectError(promise: Promise<unknown>, code: 'FORBIDDEN' | 'UNAUTHORIZED') {
  try {
    await promise;
    throw new Error(`expected ${code}, but call succeeded`);
  } catch (err) {
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe(code);
  }
}

describe('email черновики', () => {
  it('saveDraft создаёт черновик — виден в drafts (расшифрован), не в out', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const { id } = await caller.email.saveDraft({
      to: 'draft@example.com',
      subject: 'Черновик 1',
      bodyText: 'недописанное письмо',
    });
    expect(id).toBeTruthy();

    const drafts = await caller.email.list({ folder: 'drafts' });
    expect(drafts.items.length).toBe(1);
    expect(drafts.items[0]?.subject).toBe('Черновик 1');
    expect(drafts.items[0]?.to).toBe('draft@example.com');
    expect(drafts.items[0]?.status).toBe('draft');

    const out = await caller.email.list({ folder: 'out' });
    expect(out.items.length).toBe(0);

    const full = await caller.email.get({ id });
    expect(full?.bodyText).toBe('недописанное письмо');
  });

  it('saveDraft с id обновляет тот же черновик (без дубля)', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const { id } = await caller.email.saveDraft({ subject: 'v1', bodyText: 'a' });
    const { id: id2 } = await caller.email.saveDraft({ id, subject: 'v2', bodyText: 'b' });
    expect(id2).toBe(id);

    const drafts = await caller.email.list({ folder: 'drafts' });
    expect(drafts.items.length).toBe(1);
    expect(drafts.items[0]?.subject).toBe('v2');

    const full = await caller.email.get({ id });
    expect(full?.bodyText).toBe('b');
  });

  it('частичный черновик (только тема) сохраняется', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const { id } = await caller.email.saveDraft({ subject: 'только тема' });
    const full = await caller.email.get({ id });
    expect(full?.subject).toBe('только тема');
    expect(full?.to).toBeNull();
  });

  it('отправка из черновика переводит ту же строку в sent (без дубля)', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const { id } = await caller.email.saveDraft({
      to: 'send@example.com',
      subject: 'Из черновика',
      bodyText: 'тело',
    });

    const res = await caller.email.send({
      to: 'send@example.com',
      subject: 'Из черновика',
      bodyText: 'тело',
      fromDraftId: id,
    });
    expect(res.status).toBe('sent');

    const drafts = await caller.email.list({ folder: 'drafts' });
    expect(drafts.items.length).toBe(0);

    const out = await caller.email.list({ folder: 'out' });
    expect(out.items.length).toBe(1);
    expect(out.items[0]?.id).toBe(id);
    expect(out.items[0]?.status).toBe('sent');
  });

  it('engineer → FORBIDDEN на saveDraft', async () => {
    const caller = appRouter.createCaller(makeCtx('engineer'));
    await expectError(caller.email.saveDraft({ subject: 'x' }), 'FORBIDDEN');
  });
});
