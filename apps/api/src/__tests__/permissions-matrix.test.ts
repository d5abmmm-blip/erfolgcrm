/**
 * Матрица прав доступа: для каждой роли × нескольких чувствительных endpoint'ов
 * проверяем что без нужной роли (или без сессии) tRPC выкидывает FORBIDDEN/UNAUTHORIZED.
 *
 * Это негативные тесты — они защищают от регрессии RBAC, когда кто-то случайно
 * заменит directorProcedure на authedProcedure.
 *
 * Контекст собирается руками (минимальный mock SessionData/Context), без HTTP-слоя.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getDb, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let engineerId = '';
let dispatcherId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const eng = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!eng || !disp) throw new Error('seed missing engineer/dispatcher');
  engineerId = eng.id;
  dispatcherId = disp.id;
});

function tenantCtx() {
  return {
    id: erfolgId,
    subdomain: 'erfolg',
    displayName: 'erfolg',
    status: 'active' as const,
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    cookie: () => {},
    clearCookie: () => {},
    req: { cookies: {} },
  };
  return res;
}

function makeCtx(opts: {
  role?: 'director' | 'dispatcher' | 'engineer' | 'anonymous';
  userId?: string;
}): Context {
  let session: SessionData | null = null;
  if (opts.role && opts.role !== 'anonymous') {
    session = {
      tenantId: erfolgId,
      userId: opts.userId ?? engineerId,
      username: `${opts.role}-test`,
      role: opts.role,
      fullName: `Test ${opts.role}`,
      expiresAt: Date.now() + 3600_000,
    };
  }
  return {
    db: getDb(),
    tenant: tenantCtx(),
    session,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
  };
}

async function expectForbiddenOrUnauthorized(
  promise: Promise<unknown>,
  expectCode: 'FORBIDDEN' | 'UNAUTHORIZED',
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${expectCode}, but call succeeded`);
  } catch (err) {
    expect(err).toBeInstanceOf(TRPCError);
    const code = (err as TRPCError).code;
    expect(code).toBe(expectCode);
  }
}

describe('permissions matrix: engineer не имеет доступа к director-only', () => {
  it('users.create → FORBIDDEN для engineer', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expectForbiddenOrUnauthorized(
      caller.users.create({
        username: 'should_fail',
        password: 'StrongPass1',
        fullName: 'Test',
        role: 'engineer',
      }),
      'FORBIDDEN',
    );
  });

  it('users.setActive → FORBIDDEN для engineer', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expectForbiddenOrUnauthorized(
      caller.users.setActive({ userId: dispatcherId, isActive: false }),
      'FORBIDDEN',
    );
  });

  it('audit.list → FORBIDDEN для engineer', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expectForbiddenOrUnauthorized(caller.audit.list({}), 'FORBIDDEN');
  });

  it('attestations.create → FORBIDDEN для engineer', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expectForbiddenOrUnauthorized(
      caller.attestations.create({
        engineerId,
        category: 'medical_devices',
        issuedAt: '2026-01-01',
      }),
      'FORBIDDEN',
    );
  });

  it('clients.archive → FORBIDDEN для engineer', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    // archive — directorProcedure. Передаём заведомо несуществующий uuid;
    // если RBAC сработал — ошибка FORBIDDEN до бизнес-логики.
    await expectForbiddenOrUnauthorized(
      caller.clients.archive({ id: '00000000-0000-0000-0000-000000000000' }),
      'FORBIDDEN',
    );
  });

  it('dashboard.getMetrics → FORBIDDEN для engineer (только директор)', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expectForbiddenOrUnauthorized(
      caller.dashboard.getMetrics({ preset: 'today' }),
      'FORBIDDEN',
    );
  });

  it('invoices.listForTenant → FORBIDDEN для engineer (весь инвойс-бук тенанта — staff)', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expectForbiddenOrUnauthorized(caller.invoices.listForTenant({}), 'FORBIDDEN');
  });

  it('invoices.listByClient → FORBIDDEN для engineer (счета клиента — staff)', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expectForbiddenOrUnauthorized(
      caller.invoices.listByClient({ clientId: '00000000-0000-0000-0000-000000000000' }),
      'FORBIDDEN',
    );
  });
});

describe('permissions matrix: staff сохраняет доступ к инвойс-буку (не пере-ограничили)', () => {
  it('invoices.listForTenant → ОК для dispatcher', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher', userId: dispatcherId }));
    await expect(caller.invoices.listForTenant({})).resolves.toBeDefined();
  });
});

describe('permissions matrix: dispatcher не имеет доступа к director-only', () => {
  it('users.create → FORBIDDEN для dispatcher', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await expectForbiddenOrUnauthorized(
      caller.users.create({
        username: 'should_fail2',
        password: 'StrongPass1',
        fullName: 'Test',
        role: 'engineer',
      }),
      'FORBIDDEN',
    );
  });

  it('users.setActive → FORBIDDEN для dispatcher', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await expectForbiddenOrUnauthorized(
      caller.users.setActive({ userId: engineerId, isActive: false }),
      'FORBIDDEN',
    );
  });

  it('audit.list → FORBIDDEN для dispatcher', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await expectForbiddenOrUnauthorized(caller.audit.list({}), 'FORBIDDEN');
  });

  it('attestations.create → FORBIDDEN для dispatcher', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await expectForbiddenOrUnauthorized(
      caller.attestations.create({
        engineerId,
        category: 'medical_devices',
        issuedAt: '2026-01-01',
      }),
      'FORBIDDEN',
    );
  });
});

describe('permissions matrix: anonymous (без сессии) → UNAUTHORIZED', () => {
  it('tickets.list → UNAUTHORIZED', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'anonymous' }));
    await expectForbiddenOrUnauthorized(caller.tickets.list({}), 'UNAUTHORIZED');
  });

  it('dashboard.getMetrics → UNAUTHORIZED', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'anonymous' }));
    await expectForbiddenOrUnauthorized(
      caller.dashboard.getMetrics({ preset: 'today' }),
      'UNAUTHORIZED',
    );
  });

  it('audit.list → UNAUTHORIZED', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'anonymous' }));
    await expectForbiddenOrUnauthorized(caller.audit.list({}), 'UNAUTHORIZED');
  });
});
