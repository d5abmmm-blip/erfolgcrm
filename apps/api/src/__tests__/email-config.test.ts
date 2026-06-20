/**
 * email.getConfig / setConfig (раздел «Почта», настройки ящика):
 *   • директор сохраняет реквизиты → пароль не возвращается наружу, hasSmtpPassword=true;
 *   • пароль шифруется и расшифровывается (roundtrip через getTransportConfig);
 *   • пустой пароль при повторном сохранении не затирает существующий;
 *   • dispatcher → FORBIDDEN, anonymous → UNAUTHORIZED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { emailConfigs, getDb, getTenantEncryptionKey, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { getTransportConfig } from '../modules/email/repository';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(emailConfigs).where(eq(emailConfigs.tenantId, erfolgId)),
  );
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

const baseConfig = {
  enabled: true,
  fromName: 'ООО Эрфольг',
  fromEmail: 'erfolgmt@example.ru',
  smtpHost: 'smtp.example.ru',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: 'erfolgmt@example.ru',
  smtpPassword: 'secret-pw-123',
  imapHost: null,
  imapPort: null,
  imapSecure: true,
  imapUser: null,
  signature: null,
};

describe('email config', () => {
  it('директор сохраняет — пароль не возвращается, hasSmtpPassword=true', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    const res = await caller.email.setConfig(baseConfig);
    expect(res?.smtpHost).toBe('smtp.example.ru');
    expect(res?.hasSmtpPassword).toBe(true);
    // пароль ни в каком виде не уходит в DTO
    expect(JSON.stringify(res)).not.toContain('secret-pw-123');

    const got = await caller.email.getConfig();
    expect(got?.fromEmail).toBe('erfolgmt@example.ru');
    expect(got?.enabled).toBe(true);
    expect(got?.hasSmtpPassword).toBe(true);
  });

  it('пароль шифруется и расшифровывается (roundtrip)', async () => {
    const key = getTenantEncryptionKey({ id: erfolgId, kmsKeyId: null });
    const cfg = await getTransportConfig(getDb(), erfolgId, key);
    expect(cfg?.password).toBe('secret-pw-123');
    expect(cfg?.host).toBe('smtp.example.ru');
    expect(cfg?.from).toBe('ООО Эрфольг <erfolgmt@example.ru>');
  });

  it('пустой пароль при повторном сохранении не затирает существующий', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    await caller.email.setConfig({ ...baseConfig, smtpPassword: undefined, fromName: 'Новое имя' });
    const key = getTenantEncryptionKey({ id: erfolgId, kmsKeyId: null });
    const cfg = await getTransportConfig(getDb(), erfolgId, key);
    expect(cfg?.password).toBe('secret-pw-123');
    const got = await caller.email.getConfig();
    expect(got?.fromName).toBe('Новое имя');
  });

  it('подпись сохраняется и возвращается (getConfig + getSignature)', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    await caller.email.setConfig({ ...baseConfig, signature: 'С уважением,\nООО «Эрфольг»' });
    const got = await caller.email.getConfig();
    expect(got?.signature).toBe('С уважением,\nООО «Эрфольг»');
    // staff-доступ к подписи (для подстановки в окне написания)
    const dispatcher = appRouter.createCaller(makeCtx('dispatcher'));
    expect(await dispatcher.email.getSignature()).toBe('С уважением,\nООО «Эрфольг»');
  });

  it('dispatcher → FORBIDDEN (настройки только директор)', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    await expectError(caller.email.getConfig(), 'FORBIDDEN');
    await expectError(caller.email.setConfig(baseConfig), 'FORBIDDEN');
  });

  it('anonymous → UNAUTHORIZED', async () => {
    const caller = appRouter.createCaller(makeCtx('anonymous'));
    await expectError(caller.email.getConfig(), 'UNAUTHORIZED');
  });
});
