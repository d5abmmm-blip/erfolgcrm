/**
 * Stage 10'.C — 2FA TOTP tests.
 *
 * Покрытие:
 *   1. setup2fa.start возвращает secret + otpauthUrl, не пишет в БД.
 *   2. setup2fa.confirm с правильным кодом включает 2FA, выдаёт 10 recovery-кодов,
 *      секрет в БД зашифрован (читается только через pgp_sym_decrypt с PII-ключом).
 *   3. setup2fa.confirm с неправильным кодом → ошибка, 2FA не включается.
 *   4. login пользователя с 2FA возвращает needs2fa+challengeToken БЕЗ session-cookie.
 *   5. verify2fa с правильным TOTP создаёт session.
 *   6. verify2fa с неправильным TOTP → UNAUTHORIZED + AuditLog login_failed.
 *   7. verify2fa с recovery-кодом создаёт session и код больше не работает.
 *   8. disable2fa с правильным паролем+кодом → отключает; повторный login без 2FA.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { hash } from 'argon2';
import {
  auditLogs,
  getDb,
  getTenantEncryptionKey,
  users,
  withTenantTx,
} from '@erfolg/db';
import { TRPCError } from '@trpc/server';
import { ensureSeed } from './setup';
import { authRouter } from '../modules/auth/router';
import {
  generateTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCodes,
  verifyTotp,
} from '../modules/auth/totp';
import { _resetAttemptsForTests } from '../modules/auth/challenge';
import { generate as totpGenerate } from 'otplib';

const TEST_PREFIX = 'test_2fa_';
const PASSWORD = 'StrongPass1';

let erfolgId = '';

const tenantCtxBase = {
  status: 'active' as const,
  timezone: 'Europe/Moscow',
  kmsKeyId: null,
};

function tenantCtx() {
  return { id: erfolgId, subdomain: 'erfolg', displayName: 'erfolg', ...tenantCtxBase };
}

function fakeRes() {
  const cookies: Array<{ name: string; value: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    cookie: (name: string, value: string) => {
      cookies.push({ name, value });
    },
    clearCookie: () => {},
    req: { cookies: {} },
    _cookies: cookies,
  };
  return res;
}

interface CreatedUser {
  id: string;
  username: string;
  password: string;
}

let counter = 0;
async function createDirectorWithPassword(): Promise<CreatedUser> {
  counter += 1;
  const username = `${TEST_PREFIX}d${Date.now()}_${counter}`;
  const passwordHash = await hash(PASSWORD);
  return withTenantTx(getDb(), erfolgId, async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        tenantId: erfolgId,
        username,
        fullName: 'Test Director 2FA',
        role: 'director',
        passwordHash,
        isActive: true,
      })
      .returning({ id: users.id, username: users.username });
    if (!row) throw new Error('insert failed');
    return { id: row.id, username: row.username, password: PASSWORD };
  });
}

async function clearTestUsers(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(users).where(like(users.username, `${TEST_PREFIX}%`));
  });
}

function makeCaller(opts: { sessionUserId?: string; sessionUsername?: string } = {}) {
  const res = fakeRes();
  const caller = authRouter.createCaller({
    db: getDb(),
    tenant: tenantCtx(),
    session: opts.sessionUserId
      ? {
          tenantId: erfolgId,
          userId: opts.sessionUserId,
          username: opts.sessionUsername ?? 'director',
          role: 'director',
          fullName: 'Test',
          expiresAt: Date.now() + 3600_000,
        }
      : null,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res,
  });
  return { caller, res };
}

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

beforeEach(async () => {
  _resetAttemptsForTests();
  await clearTestUsers();
});

describe('auth.twoFactor.setup.start', () => {
  it('возвращает secret + otpauthUrl, ничего не пишет в БД', async () => {
    const u = await createDirectorWithPassword();
    const { caller } = makeCaller({ sessionUserId: u.id, sessionUsername: u.username });
    const result = await caller.twoFactor.setup.start();
    expect(result.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(result.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(result.otpauthUrl).toContain('issuer=Erfolg');

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(users).where(eq(users.id, u.id)),
    );
    expect(row?.totpEnabledAt).toBeNull();
    expect(row?.totpSecretEnc).toBeNull();
    expect(row?.recoveryCodesHashes).toBeNull();
  });
});

describe('auth.twoFactor.setup.confirm', () => {
  it('с правильным кодом включает 2FA, возвращает 10 recovery-кодов; секрет в БД зашифрован', async () => {
    const u = await createDirectorWithPassword();
    const { caller } = makeCaller({ sessionUserId: u.id, sessionUsername: u.username });
    const { secret } = await caller.twoFactor.setup.start();
    const code = await totpGenerate({ secret, strategy: 'totp', period: 30, digits: 6 });
    const { recoveryCodes } = await caller.twoFactor.setup.confirm({ secret, code });

    expect(recoveryCodes).toHaveLength(10);
    for (const c of recoveryCodes) {
      expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }

    // BD: enabled, hashes есть, секрет лежит зашифрованным (raw bytea ≠ открытый секрет)
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(users).where(eq(users.id, u.id)),
    );
    expect(row?.totpEnabledAt).not.toBeNull();
    expect(Array.isArray(row?.recoveryCodesHashes)).toBe(true);
    expect((row?.recoveryCodesHashes as string[]).length).toBe(10);
    // Сырой bytea не равен plain-секрету
    const rawString = (row?.totpSecretEnc as unknown as string) ?? '';
    expect(rawString).not.toContain(secret);

    // Дешифровка тем же ключом возвращает исходный secret
    const key = getTenantEncryptionKey(tenantCtx());
    const [decrypted] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          s: sql<string>`pgp_sym_decrypt(${users.totpSecretEnc}::bytea, ${key})::text`,
        })
        .from(users)
        .where(eq(users.id, u.id)),
    );
    expect(decrypted?.s).toBe(secret);
  });

  it('с неправильным кодом → UNAUTHORIZED, 2FA не включается', async () => {
    const u = await createDirectorWithPassword();
    const { caller } = makeCaller({ sessionUserId: u.id, sessionUsername: u.username });
    const { secret } = await caller.twoFactor.setup.start();
    await expect(caller.twoFactor.setup.confirm({ secret, code: '000000' })).rejects.toBeInstanceOf(
      TRPCError,
    );
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(users).where(eq(users.id, u.id)),
    );
    expect(row?.totpEnabledAt).toBeNull();
  });
});

describe('auth.login + auth.verify2fa', () => {
  async function setup2faOnUser(u: CreatedUser): Promise<{ secret: string; recoveryCodes: string[] }> {
    const secret = generateTotpSecret();
    const codes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(codes);
    const { enableTwoFactor } = await import('../modules/auth/two-factor');
    await enableTwoFactor(getDb(), tenantCtx(), u.id, secret, hashes);
    return { secret, recoveryCodes: codes };
  }

  it('login с активной 2FA возвращает needs2fa+challengeToken, не ставит cookie', async () => {
    const u = await createDirectorWithPassword();
    await setup2faOnUser(u);
    const { caller, res } = makeCaller();
    const out = await caller.login({ username: u.username, password: u.password });
    expect(out.needs2fa).toBe(true);
    if (out.needs2fa) {
      expect(typeof out.challengeToken).toBe('string');
      expect(out.challengeToken.length).toBeGreaterThan(20);
    }
    // cookie session_token НЕ должна быть установлена при needs2fa
    expect(res._cookies.find((c: { name: string }) => c.name === 'session_token')).toBeUndefined();
  });

  it('verify2fa с правильным TOTP → создаёт session', async () => {
    const u = await createDirectorWithPassword();
    const { secret } = await setup2faOnUser(u);
    const { caller, res } = makeCaller();
    const login = await caller.login({ username: u.username, password: u.password });
    expect(login.needs2fa).toBe(true);
    if (!login.needs2fa) throw new Error('expected needs2fa');

    const code = await totpGenerate({ secret, strategy: 'totp', period: 30, digits: 6 });
    const verified = await caller.verify2fa({ challengeToken: login.challengeToken, code });
    expect(verified.user.id).toBe(u.id);
    expect(verified.tenant.id).toBe(erfolgId);
    // session-cookie теперь установлена
    expect(res._cookies.find((c: { name: string }) => c.name === 'session_token')).toBeDefined();

    // AuditLog 'login' c method=totp
    const [audit] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'login'), eq(auditLogs.entityId, u.id)))
        .orderBy(desc(auditLogs.ts))
        .limit(1),
    );
    expect(audit).toBeDefined();
    const ctx = audit?.context as { method?: string } | null;
    expect(ctx?.method).toBe('totp');
  });

  it('verify2fa с неправильным TOTP → UNAUTHORIZED + AuditLog login_failed', async () => {
    const u = await createDirectorWithPassword();
    await setup2faOnUser(u);
    const { caller } = makeCaller();
    const login = await caller.login({ username: u.username, password: u.password });
    if (!login.needs2fa) throw new Error('expected needs2fa');

    await expect(
      caller.verify2fa({ challengeToken: login.challengeToken, code: '000000' }),
    ).rejects.toBeInstanceOf(TRPCError);

    const [failed] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'login_failed'), eq(auditLogs.entityId, u.id)))
        .orderBy(desc(auditLogs.ts))
        .limit(1),
    );
    expect(failed).toBeDefined();
    const ctx = failed?.context as { method?: string; stage?: string } | null;
    expect(ctx?.stage).toBe('2fa');
    expect(ctx?.method).toBe('totp');
  });

  it('verify2fa с recovery-кодом → создаёт session, повторное использование кода не работает', async () => {
    const u = await createDirectorWithPassword();
    const { recoveryCodes } = await setup2faOnUser(u);
    const usedCode = recoveryCodes[0]!;
    const { caller } = makeCaller();

    const login1 = await caller.login({ username: u.username, password: u.password });
    if (!login1.needs2fa) throw new Error('expected needs2fa');
    const verified = await caller.verify2fa({
      challengeToken: login1.challengeToken,
      code: usedCode,
    });
    expect(verified.user.id).toBe(u.id);

    // Хеш этого кода должен исчезнуть из массива (одноразовость)
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(users).where(eq(users.id, u.id)),
    );
    expect((row?.recoveryCodesHashes as string[]).length).toBe(9);

    // Повторный логин + тот же recovery-код → должен провалиться
    const login2 = await caller.login({ username: u.username, password: u.password });
    if (!login2.needs2fa) throw new Error('expected needs2fa');
    await expect(
      caller.verify2fa({ challengeToken: login2.challengeToken, code: usedCode }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('disable2fa с правильным паролем+TOTP отключает; повторный login снова без 2FA', async () => {
    const u = await createDirectorWithPassword();
    const { secret } = await setup2faOnUser(u);
    const { caller } = makeCaller({ sessionUserId: u.id, sessionUsername: u.username });
    const code = await totpGenerate({ secret, strategy: 'totp', period: 30, digits: 6 });
    const result = await caller.twoFactor.disable({ password: PASSWORD, code });
    expect(result.ok).toBe(true);

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(users)
        .where(and(eq(users.id, u.id), isNull(users.deletedAt))),
    );
    expect(row?.totpEnabledAt).toBeNull();
    expect(row?.totpSecretEnc).toBeNull();
    expect(row?.recoveryCodesHashes).toBeNull();

    // Повторный логин без 2FA: возвращает обычный success-ответ
    const { caller: noSessCaller } = makeCaller();
    const login = await noSessCaller.login({ username: u.username, password: PASSWORD });
    expect(login.needs2fa).toBe(false);
  });
});

describe('TOTP helpers (sanity)', () => {
  it('verifyTotp принимает свежесгенерированный код', async () => {
    const secret = generateTotpSecret();
    const code = await totpGenerate({ secret, strategy: 'totp', period: 30, digits: 6 });
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, '000000')).toBe(false);
  });
});
