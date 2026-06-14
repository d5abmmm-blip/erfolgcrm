/**
 * settings.disabledModules:
 *   • директор сохраняет набор → нормализуется (dedupe + sort) и персистится;
 *   • getDisabledModules и auth.me возвращают то же значение;
 *   • dispatcher/engineer → FORBIDDEN на запись, но чтение доступно;
 *   • пустой набор очищает список.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { getDb, tenants } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

afterAll(async () => {
  // Возвращаем tenant в исходное «всё включено», чтобы не влиять на другие тесты.
  await getDb().update(tenants).set({ disabledModules: [] }).where(eq(tenants.id, erfolgId));
});

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
  };
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

describe('settings.setDisabledModules', () => {
  it('директор сохраняет, значение нормализуется (dedupe + sort)', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const res = await caller.settings.setDisabledModules({
      modules: ['reports', 'leads', 'reports', 'kb'],
    });
    expect(res.disabledModules).toEqual(['kb', 'leads', 'reports']);

    // getDisabledModules возвращает то же
    const got = await caller.settings.getDisabledModules();
    expect(got).toEqual(['kb', 'leads', 'reports']);

    // auth.me тоже отдаёт актуальный список
    const me = await caller.auth.me();
    expect(me?.tenant.disabledModules).toEqual(['kb', 'leads', 'reports']);
  });

  it('пустой набор очищает список', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const res = await caller.settings.setDisabledModules({ modules: [] });
    expect(res.disabledModules).toEqual([]);
    const got = await caller.settings.getDisabledModules();
    expect(got).toEqual([]);
  });

  it('dispatcher → FORBIDDEN на запись, но чтение доступно', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    await expectError(caller.settings.setDisabledModules({ modules: ['leads'] }), 'FORBIDDEN');
    await expect(caller.settings.getDisabledModules()).resolves.toBeInstanceOf(Array);
  });

  it('engineer → FORBIDDEN на запись', async () => {
    const caller = appRouter.createCaller(makeCtx('engineer'));
    await expectError(caller.settings.setDisabledModules({ modules: ['kb'] }), 'FORBIDDEN');
  });

  it('anonymous → UNAUTHORIZED на чтение и запись', async () => {
    const caller = appRouter.createCaller(makeCtx('anonymous'));
    await expectError(caller.settings.getDisabledModules(), 'UNAUTHORIZED');
    await expectError(caller.settings.setDisabledModules({ modules: ['kb'] }), 'UNAUTHORIZED');
  });
});
