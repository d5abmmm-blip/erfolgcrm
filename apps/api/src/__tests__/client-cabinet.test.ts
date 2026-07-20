/**
 * Stage 10'.H — кабинет клиента: тесты MVP-функционала.
 *
 * Покрытие:
 *   1. createClientUser + login + me — happy path.
 *   2. login с неверным паролем → UNAUTHORIZED + AuditLog login_failed.
 *   3. login заблокированной учётки → FORBIDDEN.
 *   4. listAssets возвращает только assets своего клиента.
 *   5. createTicket с чужим asset_id → FORBIDDEN.
 *   6. listInvoices возвращает только invoices своего клиента.
 *   7. changeMyPassword: старый пароль не работает после смены.
 *   8. Cross-tenant: client_user одного tenant'а не логинится по email из другого.
 *   9. Уникальность email case-insensitive.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import {
  assets,
  auditLogs,
  clientSessions,
  clientUsers,
  clients,
  consentRecords,
  getDb,
  getTenantEncryptionKey,
  invoices,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  archiveClient,
  createClient,
  unarchiveClient,
} from '../modules/clients/repository';
import {
  ClientUserConflictError,
  changeMyClientPassword,
  createClientSession,
  createClientUser,
  findClientUserByEmail,
  getClientConsents,
  getMyAssets,
  getMyInvoices,
  getMyPaymentsForExport,
  getMyProfileForExport,
  getMyTicketsForExport,
  markClientUserDeletionRequested,
  recordClientConsentIfMissing,
  resolveClientSession,
  revokeAllClientSessions,
  revokeClientConsents,
} from '../modules/client-cabinet/repository';
import { loginClient } from '../modules/client-cabinet/auth';
import { getMyAssetForCreateTicket } from '../modules/client-cabinet/service';
import { verify } from 'argon2';

const TEST_EMAIL_PREFIX = 'cabtest';

let erfolgId = '';
let demoId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

async function clearTestClientUsers() {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(clientUsers).where(like(clientUsers.email, `${TEST_EMAIL_PREFIX}%`));
    });
  }
}

beforeEach(clearTestClientUsers);

async function pickClient(tenantId: string): Promise<{ id: string; displayName: string }> {
  const rows = await withTenantTx(getDb(), tenantId, async (tx) =>
    tx.select({ id: clients.id, displayName: clients.displayName }).from(clients).limit(1),
  );
  if (!rows[0]) throw new Error('Seed missing client');
  return rows[0];
}

function fakeRes() {
  const cookies: Record<string, { value: string; opts: Record<string, unknown> }> = {};
  return {
    cookie: (name: string, value: string, opts: Record<string, unknown>) => {
      cookies[name] = { value, opts };
    },
    clearCookie: (name: string) => {
      delete cookies[name];
    },
    cookies,
  };
}

describe('createClientUser', () => {
  it('создаёт пользователя с argon2-хешем пароля', async () => {
    const c = await pickClient(erfolgId);
    const u = await createClientUser(getDb(), erfolgId, c.id, {
      email: `${TEST_EMAIL_PREFIX}-1@example.com`,
      password: 'CabPass123!',
      fullName: 'Главбух Тестов',
      position: 'Главный бухгалтер',
    });
    expect(u.email).toBe(`${TEST_EMAIL_PREFIX}-1@example.com`);
    expect(u.isActive).toBe(true);

    const found = await findClientUserByEmail(getDb(), erfolgId, u.email);
    expect(found).toBeTruthy();
    expect(await verify(found!.passwordHash, 'CabPass123!')).toBe(true);
  });

  it('конфликт email case-insensitive', async () => {
    const c = await pickClient(erfolgId);
    await createClientUser(getDb(), erfolgId, c.id, {
      email: `${TEST_EMAIL_PREFIX}-dup@example.com`,
      password: 'Pass1234!',
      fullName: 'A',
    });
    await expect(
      createClientUser(getDb(), erfolgId, c.id, {
        email: `${TEST_EMAIL_PREFIX}-DUP@EXAMPLE.com`,
        password: 'Pass1234!',
        fullName: 'B',
      }),
    ).rejects.toBeInstanceOf(ClientUserConflictError);
  });
});

describe('login flow', () => {
  it('happy path: login → cookie → resolveClientSession → me-данные', async () => {
    const c = await pickClient(erfolgId);
    const email = `${TEST_EMAIL_PREFIX}-login@example.com`;
    await createClientUser(getDb(), erfolgId, c.id, {
      email,
      password: 'StrongPwd1',
      fullName: 'Иванов Иван',
    });

    const res = fakeRes();
    const result = await loginClient(
      {
        db: getDb(),
        tenantId: erfolgId,
        tenantSubdomain: 'erfolg',
        tenantDisplayName: 'ООО Эрфольг',
        ip: '127.0.0.1',
        userAgent: 'vitest',
        res,
      },
      { email, password: 'StrongPwd1' },
    );
    expect(result.user.email).toBe(email);
    expect(result.user.fullName).toBe('Иванов Иван');
    expect(result.user.clientId).toBe(c.id);
    expect(res.cookies.client_session_token).toBeDefined();

    // resolveClientSession должен вернуть валидную сессию
    const token = res.cookies.client_session_token!.value;
    const resolved = await resolveClientSession(getDb(), token);
    expect(resolved).toBeTruthy();
    expect(resolved!.clientUserId).toBeDefined();
    expect(resolved!.clientId).toBe(c.id);
    expect(resolved!.tenantId).toBe(erfolgId);
  });

  it('неверный пароль → UNAUTHORIZED + audit log_failed', async () => {
    const c = await pickClient(erfolgId);
    const email = `${TEST_EMAIL_PREFIX}-wrong@example.com`;
    await createClientUser(getDb(), erfolgId, c.id, {
      email,
      password: 'StrongPwd1',
      fullName: 'X',
    });
    const res = fakeRes();
    await expect(
      loginClient(
        {
          db: getDb(),
          tenantId: erfolgId,
          tenantSubdomain: 'erfolg',
          tenantDisplayName: 'ООО Эрфольг',
          ip: '127.0.0.1',
          userAgent: 'vitest',
          res,
        },
        { email, password: 'wrong-pass' },
      ),
    ).rejects.toBeInstanceOf(TRPCError);

    // AuditLog должен иметь login_failed
    const logs = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.entityType, 'client_user'), eq(auditLogs.action, 'login_failed')),
        ),
    );
    expect(logs.length).toBeGreaterThan(0);
  });

  it('заблокированная учётка → FORBIDDEN', async () => {
    const c = await pickClient(erfolgId);
    const email = `${TEST_EMAIL_PREFIX}-blocked@example.com`;
    await createClientUser(getDb(), erfolgId, c.id, {
      email,
      password: 'StrongPwd1',
      fullName: 'Z',
    });
    // Блокируем напрямую в БД
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(clientUsers).set({ isActive: false }).where(eq(clientUsers.email, email)),
    );

    const res = fakeRes();
    await expect(
      loginClient(
        {
          db: getDb(),
          tenantId: erfolgId,
          tenantSubdomain: 'erfolg',
          tenantDisplayName: 'ООО Эрфольг',
          ip: '127.0.0.1',
          userAgent: 'vitest',
          res,
        },
        { email, password: 'StrongPwd1' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('клиент в архиве → в кабинет не пускает, после возврата пускает', async () => {
    // Свой клиент, а не seed'овый: архивация seed-клиента задела бы соседние тесты.
    const key = getTenantEncryptionKey({ id: erfolgId, kmsKeyId: null });
    const { id: clientId } = await createClient(getDb(), erfolgId, key, {
      type: 'legal',
      displayName: `${TEST_EMAIL_PREFIX}-archived-client-${Date.now()}`,
    });
    const email = `${TEST_EMAIL_PREFIX}-archived@example.com`;
    await createClientUser(getDb(), erfolgId, clientId, {
      email,
      password: 'StrongPwd1',
      fullName: 'Архивный',
    });

    const login = () =>
      loginClient(
        {
          db: getDb(),
          tenantId: erfolgId,
          tenantSubdomain: 'erfolg',
          tenantDisplayName: 'ООО Эрфольг',
          ip: '127.0.0.1',
          userAgent: 'vitest',
          res: fakeRes(),
        },
        { email, password: 'StrongPwd1' },
      );

    // До архивации вход работает.
    expect((await login()).user.email).toBe(email);

    await archiveClient(getDb(), erfolgId, clientId);
    await expect(login()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Возврат из архива восстанавливает доступ сам: флаг is_active мы не
    // трогаем, поэтому «заблокирован вручную» и «клиент в архиве» не путаются.
    await unarchiveClient(getDb(), erfolgId, clientId);
    expect((await login()).user.email).toBe(email);

    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx.delete(clientUsers).where(eq(clientUsers.clientId, clientId));
      await tx.delete(clients).where(eq(clients.id, clientId));
    });
  });
});

describe('cross-tenant изоляция', () => {
  it('одинаковый email в двух tenant — это ОК, login строго своего tenant', async () => {
    const eClient = await pickClient(erfolgId);
    const dClient = await pickClient(demoId);
    const email = `${TEST_EMAIL_PREFIX}-multi@example.com`;
    await createClientUser(getDb(), erfolgId, eClient.id, {
      email,
      password: 'PassErfolg1',
      fullName: 'Erfolg User',
    });
    await createClientUser(getDb(), demoId, dClient.id, {
      email,
      password: 'PassDemo1',
      fullName: 'Demo User',
    });

    // Login с PassErfolg1 в demo-tenant должен провалиться (это юзер erfolg)
    const res = fakeRes();
    await expect(
      loginClient(
        {
          db: getDb(),
          tenantId: demoId,
          tenantSubdomain: 'demo',
          tenantDisplayName: 'demo',
          ip: '127.0.0.1',
          userAgent: 'vitest',
          res,
        },
        { email, password: 'PassErfolg1' },
      ),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('listAssets возвращает только assets своего клиента (не других клиентов того же tenant)', async () => {
    // Берём двух разных клиентов в erfolg
    const someClients = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: clients.id }).from(clients).limit(2),
    );
    expect(someClients.length).toBe(2);
    const myClientId = someClients[0]!.id;
    const otherClientId = someClients[1]!.id;

    const myAssets = await getMyAssets(getDb(), erfolgId, myClientId);
    const otherAssets = await getMyAssets(getDb(), erfolgId, otherClientId);

    // Никакие id не должны пересекаться
    const intersection = myAssets.filter((a) => otherAssets.some((o) => o.id === a.id));
    expect(intersection.length).toBe(0);
  });
});

describe('createTicket — защита asset.owner_client_id', () => {
  it('asset чужого клиента того же tenant возвращает null → роутер бросает FORBIDDEN', async () => {
    const someClients = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: clients.id }).from(clients).limit(2),
    );
    const myClientId = someClients[0]!.id;
    const otherClientId = someClients[1]!.id;

    // Берём asset чужого клиента
    const otherAssets = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.ownerClientId, otherClientId))
        .limit(1),
    );
    if (!otherAssets[0]) {
      // Если у второго клиента нет техники, тест неинформативен — пропускаем gracefully
      return;
    }
    const result = await getMyAssetForCreateTicket(
      getDb(),
      erfolgId,
      myClientId,
      otherAssets[0].id,
    );
    expect(result).toBeNull();
  });
});

describe('listInvoices — фильтр по client_id', () => {
  it('возвращает invoices только для своего client_id', async () => {
    const someClients = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: clients.id }).from(clients).limit(2),
    );
    const myClientId = someClients[0]!.id;
    const myInv = await getMyInvoices(getDb(), erfolgId, myClientId);
    // Все invoices должны иметь правильный client_id (проверка через прямой select)
    const directInv = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: invoices.id, clientId: invoices.clientId }).from(invoices),
    );
    for (const i of myInv) {
      const direct = directInv.find((d) => d.id === i.id);
      expect(direct?.clientId).toBe(myClientId);
    }
  });
});

describe('changeMyPassword', () => {
  it('старый пароль не работает после смены, новый работает', async () => {
    const c = await pickClient(erfolgId);
    const email = `${TEST_EMAIL_PREFIX}-chg@example.com`;
    const created = await createClientUser(getDb(), erfolgId, c.id, {
      email,
      password: 'OldPwd123!',
      fullName: 'Q',
    });
    const ok = await changeMyClientPassword(
      getDb(),
      erfolgId,
      created.id,
      'OldPwd123!',
      'NewPwd456!',
    );
    expect(ok).toBe(true);

    // Старым паролем уже нельзя
    const res = fakeRes();
    await expect(
      loginClient(
        {
          db: getDb(),
          tenantId: erfolgId,
          tenantSubdomain: 'erfolg',
          tenantDisplayName: 'erfolg',
          ip: '127.0.0.1',
          userAgent: 'vitest',
          res,
        },
        { email, password: 'OldPwd123!' },
      ),
    ).rejects.toBeInstanceOf(TRPCError);

    // Новым — можно
    const res2 = fakeRes();
    const result = await loginClient(
      {
        db: getDb(),
        tenantId: erfolgId,
        tenantSubdomain: 'erfolg',
        tenantDisplayName: 'erfolg',
        ip: '127.0.0.1',
        userAgent: 'vitest',
        res: res2,
      },
      { email, password: 'NewPwd456!' },
    );
    expect(result.user.email).toBe(email);
  });
});

describe('session lifecycle', () => {
  it('недействительный токен → null', async () => {
    const resolved = await resolveClientSession(getDb(), 'no-such-token-zzz');
    expect(resolved).toBeNull();
    // Подавляем неиспользуемые импорты
    expect(sql).toBeDefined();
    expect(clientSessions).toBeDefined();
    expect(createClientSession).toBeDefined();
  });
});

/* ───────────── 152-ФЗ — consent при логине + DSAR ───────────── */

async function clearConsentRecordsForUser(tenantId: string, subjectId: string) {
  await withTenantTx(getDb(), tenantId, async (tx) => {
    await tx
      .delete(consentRecords)
      .where(
        and(
          eq(consentRecords.subjectType, 'client_user'),
          eq(consentRecords.subjectId, subjectId),
        ),
      );
  });
}

describe('152-ФЗ: consent_records при логине клиента', () => {
  it('первый успешный логин вставляет consent (idempotent при повторном логине)', async () => {
    const c = await pickClient(erfolgId);
    const email = `${TEST_EMAIL_PREFIX}-consent@example.com`;
    const created = await createClientUser(getDb(), erfolgId, c.id, {
      email,
      password: 'StrongPwd1',
      fullName: 'Согласная Тестовая',
    });
    await clearConsentRecordsForUser(erfolgId, created.id);

    // Первый login — должна появиться запись.
    const res1 = fakeRes();
    await loginClient(
      {
        db: getDb(),
        tenantId: erfolgId,
        tenantSubdomain: 'erfolg',
        tenantDisplayName: 'ООО Эрфольг',
        ip: '127.0.0.1',
        userAgent: 'vitest',
        res: res1,
      },
      { email, password: 'StrongPwd1' },
    );

    const consents1 = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.subjectType, 'client_user'),
            eq(consentRecords.subjectId, created.id),
            eq(consentRecords.consentType, 'pdn_processing'),
          ),
        ),
    );
    expect(consents1.length).toBe(1);
    expect(consents1[0]!.policyVersion).toBe('1.0');
    expect(consents1[0]!.revokedAt).toBeNull();

    // AuditLog должен содержать consent_given
    const auditLogsRows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, 'client_user'),
            eq(auditLogs.entityId, created.id),
            eq(auditLogs.action, 'consent_given'),
          ),
        ),
    );
    expect(auditLogsRows.length).toBe(1);

    // Второй login — записей по-прежнему одна (idempotency).
    const res2 = fakeRes();
    await loginClient(
      {
        db: getDb(),
        tenantId: erfolgId,
        tenantSubdomain: 'erfolg',
        tenantDisplayName: 'ООО Эрфольг',
        ip: '127.0.0.1',
        userAgent: 'vitest',
        res: res2,
      },
      { email, password: 'StrongPwd1' },
    );
    const consents2 = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.subjectType, 'client_user'),
            eq(consentRecords.subjectId, created.id),
            eq(consentRecords.consentType, 'pdn_processing'),
            isNull(consentRecords.revokedAt),
          ),
        ),
    );
    expect(consents2.length).toBe(1);
  });

  it('recordClientConsentIfMissing возвращает true для нового и false для повтора', async () => {
    const c = await pickClient(erfolgId);
    const u = await createClientUser(getDb(), erfolgId, c.id, {
      email: `${TEST_EMAIL_PREFIX}-rec@example.com`,
      password: 'Pass1234!',
      fullName: 'X',
    });
    await clearConsentRecordsForUser(erfolgId, u.id);

    expect(await recordClientConsentIfMissing(getDb(), erfolgId, u.id)).toBe(true);
    expect(await recordClientConsentIfMissing(getDb(), erfolgId, u.id)).toBe(false);

    // После revoke вставка снова должна сработать
    await revokeClientConsents(getDb(), erfolgId, u.id);
    expect(await recordClientConsentIfMissing(getDb(), erfolgId, u.id)).toBe(true);
  });
});

describe('152-ФЗ: DSAR — exportMyData / requestAccountDeletion', () => {
  it('exportMyData возвращает профиль, согласия и связанные сущности; пишет audit export', async () => {
    const c = await pickClient(erfolgId);
    const email = `${TEST_EMAIL_PREFIX}-dsar@example.com`;
    const created = await createClientUser(getDb(), erfolgId, c.id, {
      email,
      password: 'StrongPwd1',
      fullName: 'DSAR Tester',
    });
    await clearConsentRecordsForUser(erfolgId, created.id);
    // Вход — фиксирует consent
    const res = fakeRes();
    await loginClient(
      {
        db: getDb(),
        tenantId: erfolgId,
        tenantSubdomain: 'erfolg',
        tenantDisplayName: 'ООО Эрфольг',
        ip: '127.0.0.1',
        userAgent: 'vitest',
        res,
      },
      { email, password: 'StrongPwd1' },
    );

    // Симулируем то, что делает clientCabinet.exportMyData в роутере:
    // вызываем те же helpers и проверяем shape результата.
    const profile = await getMyProfileForExport(getDb(), erfolgId, created.id);
    const consents = await getClientConsents(getDb(), erfolgId, created.id);
    const tickets = await getMyTicketsForExport(getDb(), erfolgId, c.id);
    const myAssets = await getMyAssets(getDb(), erfolgId, c.id);
    const myInvoices = await getMyInvoices(getDb(), erfolgId, c.id);
    const myPayments = await getMyPaymentsForExport(getDb(), erfolgId, c.id);

    expect(profile).toBeTruthy();
    expect(profile!.email).toBe(email);
    expect(profile!.id).toBe(created.id);
    expect(profile!.clientId).toBe(c.id);

    // Хотя бы одно активное согласие — pdn_processing.
    expect(consents.some((x) => x.consentType === 'pdn_processing' && x.revokedAt === null))
      .toBe(true);

    // Связанные коллекции — массивы (могут быть пустыми, но всегда массивы).
    expect(Array.isArray(tickets)).toBe(true);
    expect(Array.isArray(myAssets)).toBe(true);
    expect(Array.isArray(myInvoices)).toBe(true);
    expect(Array.isArray(myPayments)).toBe(true);
  });

  it('markClientUserDeletionRequested + revokeClientConsents + revokeAllClientSessions', async () => {
    const c = await pickClient(erfolgId);
    const email = `${TEST_EMAIL_PREFIX}-del@example.com`;
    const created = await createClientUser(getDb(), erfolgId, c.id, {
      email,
      password: 'StrongPwd1',
      fullName: 'Del Tester',
    });
    await clearConsentRecordsForUser(erfolgId, created.id);
    // Делаем активную сессию + consent.
    const res = fakeRes();
    await loginClient(
      {
        db: getDb(),
        tenantId: erfolgId,
        tenantSubdomain: 'erfolg',
        tenantDisplayName: 'ООО Эрфольг',
        ip: '127.0.0.1',
        userAgent: 'vitest',
        res,
      },
      { email, password: 'StrongPwd1' },
    );
    const sessionToken = res.cookies.client_session_token!.value;
    const beforeResolve = await resolveClientSession(getDb(), sessionToken);
    expect(beforeResolve).toBeTruthy();

    // 1) Mark deletion
    const ok = await markClientUserDeletionRequested(getDb(), erfolgId, created.id);
    expect(ok).toBe(true);

    // 2) Revoke consents
    await revokeClientConsents(getDb(), erfolgId, created.id);
    const afterRevokeConsents = await getClientConsents(getDb(), erfolgId, created.id);
    for (const r of afterRevokeConsents) {
      expect(r.revokedAt).not.toBeNull();
    }

    // 3) Revoke sessions — сессия больше не резолвится.
    await revokeAllClientSessions(getDb(), erfolgId, created.id);
    const afterResolve = await resolveClientSession(getDb(), sessionToken);
    expect(afterResolve).toBeNull();

    // 4) Учётка деактивирована и помечена.
    const row = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(clientUsers).where(eq(clientUsers.id, created.id)).limit(1),
    );
    expect(row[0]?.isActive).toBe(false);
    expect(row[0]?.deletionRequestedAt).not.toBeNull();
  });
});
