/**
 * Stage 10'.I — Аттестация инженеров.
 *
 * Проверяем:
 *   1. createAttestation работает + успех виден через listAttestations.
 *   2. cross-tenant: аттестация erfolg не видна из demo (RLS).
 *   3. getActiveCategoriesForEngineer — возвращает только не-просроченные на сегодня
 *      (бессрочные тоже считаются активными).
 *   4. softDeleteAttestation — после удаления отсутствует в list, но строка есть в БД с deleted_at.
 *   5. updateAttestation — нельзя поставить validUntil < issuedAt (через router-валидацию);
 *      после установки validUntil в прошлое getActiveCategoriesForEngineer её исключает.
 *   6. checkAttestationForAssignment + назначение в createTicketCmd:
 *      - asset с requiredAttestationCategory без аттестации у инженера → возвращает warning;
 *      - с аттестацией → warning = null.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, isNull, like, ne, or } from 'drizzle-orm';
import {
  assets,
  clients,
  engineerAttestations,
  getDb,
  tickets,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  checkAttestationForAssignment,
  createAttestation,
  getActiveCategoriesForEngineer,
  getAttestationById,
  listAttestations,
  softDeleteAttestation,
  updateAttestation,
} from '../modules/attestations';
import { createTicketCmd } from '../modules/tickets/service';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-ATTEST-';
const TEST_CATEGORY_A = 'Лабораторное оборудование';
const TEST_CATEGORY_B = 'Стерилизационное оборудование';

let erfolgId = '';
let demoId = '';
let erfolgEngineerId = '';
let erfolgDispatcherId = '';
let erfolgClientId = '';
let erfolgAssetId = '';

const ONE_DAY = 86_400_000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoOffset(days: number): string {
  return new Date(Date.now() + days * ONE_DAY).toISOString().slice(0, 10);
}

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  // Берём первого engineer'а и dispatcher'а в erfolg.
  const eng = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'engineer')).limit(1),
  );
  if (!eng[0]) throw new Error('seed missing engineer');
  erfolgEngineerId = eng[0].id;

  const disp = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'dispatcher')).limit(1),
  );
  if (!disp[0]) throw new Error('seed missing dispatcher');
  erfolgDispatcherId = disp[0].id;

  // Берём первый asset, чей владелец-клиент коммерческий ИЛИ физлицо
  // (для бюджетников createTicketCmd требует контракт — портит наши asserts).
  const a = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      // ownerClientId берём из clients.id (innerJoin) — гарантированно не null.
      .select({ id: assets.id, ownerClientId: clients.id })
      .from(assets)
      .innerJoin(clients, eq(clients.id, assets.ownerClientId))
      .where(or(ne(clients.subtype, 'budget'), isNull(clients.subtype))),
  );
  if (a.length === 0) throw new Error('seed missing commercial asset');
  erfolgAssetId = a[0]!.id;
  erfolgClientId = a[0]!.ownerClientId;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      // hard delete тестовых аттестаций (включая soft-deleted).
      await tx
        .delete(engineerAttestations)
        .where(like(engineerAttestations.notes, `${TEST_PREFIX}%`));
      // Тикеты от тестов.
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    });
  }
  // Сбрасываем requiredAttestationCategory на тестовом ассете.
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .update(assets)
      .set({ requiredAttestationCategory: null })
      .where(eq(assets.id, erfolgAssetId)),
  );
}

beforeEach(clearTestData);

function makeCmdCtx(
  tenantId: string,
  userId: string,
  role: 'director' | 'dispatcher' = 'dispatcher',
) {
  const tenant: ResolvedTenant = {
    id: tenantId,
    subdomain: 'test',
    displayName: 'test',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
  const session: SessionData = {
    tenantId,
    userId,
    username: 'test',
    role,
    fullName: 'Test User',
    expiresAt: Date.now() + 60_000,
  };
  return {
    db: getDb(),
    tenant,
    session,
    audit: { ip: null, userAgent: null },
  };
}

/** Полный tRPC-контекст: нужен там, где проверяем права, а не чистую логику. */
function makeRouterCtx(role: 'director' | 'dispatcher' | 'engineer'): Context {
  const userId = role === 'engineer' ? erfolgEngineerId : erfolgDispatcherId;
  return {
    db: getDb(),
    tenant: {
      id: erfolgId,
      subdomain: 'erfolg',
      displayName: 'erfolg',
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    },
    session: {
      tenantId: erfolgId,
      userId,
      username: `${role}-test`,
      role,
      fullName: `Test ${role}`,
      expiresAt: Date.now() + 3600_000,
    },
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } } as any,
  };
}

/**
 * Кто заводит аттестации. Решение владельца 2026-08-14: вносить и править разрешено
 * менеджеру — модуль стоял пустым ровно потому, что это мог только директор, а он в
 * программе бывает реже. Удаление осталось директорским: это документ о допуске.
 */
describe('права на аттестации', () => {
  it('менеджер заводит аттестацию и правит её', async () => {
    const caller = appRouter.createCaller(makeRouterCtx('dispatcher'));
    const created = await caller.attestations.create({
      engineerId: erfolgEngineerId,
      category: TEST_CATEGORY_A,
      issuedAt: isoOffset(-10),
      validUntil: isoOffset(200),
      notes: `${TEST_PREFIX}rbac-dispatcher`,
    });
    expect(created.id).toBeTruthy();

    const updated = await caller.attestations.update({
      id: created.id,
      patch: { certificateNumber: 'УЦ-777' },
    });
    expect(updated.certificateNumber).toBe('УЦ-777');
  });

  it('менеджер не может удалить аттестацию', async () => {
    const director = appRouter.createCaller(makeRouterCtx('director'));
    const created = await director.attestations.create({
      engineerId: erfolgEngineerId,
      category: TEST_CATEGORY_A,
      issuedAt: isoOffset(-10),
      notes: `${TEST_PREFIX}rbac-remove`,
    });

    const dispatcher = appRouter.createCaller(makeRouterCtx('dispatcher'));
    await expect(dispatcher.attestations.remove({ id: created.id })).rejects.toThrow(
      /Доступ только для ролей/i,
    );

    // Запись на месте — отказ не оставил половинчатого состояния.
    const still = await listAttestations(getDb(), erfolgId, { engineerId: erfolgEngineerId });
    expect(still.find((r) => r.id === created.id)).toBeDefined();
  });

  it('инженер не заводит аттестации даже себе', async () => {
    const caller = appRouter.createCaller(makeRouterCtx('engineer'));
    await expect(
      caller.attestations.create({
        engineerId: erfolgEngineerId,
        category: TEST_CATEGORY_A,
        issuedAt: isoOffset(-10),
        notes: `${TEST_PREFIX}rbac-engineer`,
      }),
    ).rejects.toThrow(/Доступ только для ролей/i);
  });
});

describe('createAttestation + listAttestations', () => {
  it('создаёт аттестацию и возвращает её через list', async () => {
    const created = await createAttestation(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      category: TEST_CATEGORY_A,
      issuedBy: 'Учебный центр Эрфольг',
      certificateNumber: 'УЦ-001',
      issuedAt: isoOffset(-30),
      validUntil: isoOffset(335),
      notes: `${TEST_PREFIX}create`,
    });
    expect(created.category).toBe(TEST_CATEGORY_A);
    expect(created.status).toBe('active');

    const list = await listAttestations(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
    });
    expect(list.find((r) => r.id === created.id)).toBeDefined();
  });
});

describe('cross-tenant изоляция', () => {
  it('аттестация erfolg не видна из demo', async () => {
    const created = await createAttestation(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      category: TEST_CATEGORY_A,
      issuedAt: isoOffset(-10),
      notes: `${TEST_PREFIX}xtenant`,
    });
    const listFromDemo = await listAttestations(getDb(), demoId);
    expect(listFromDemo.find((r) => r.id === created.id)).toBeUndefined();

    const fromDemo = await getAttestationById(getDb(), demoId, created.id);
    expect(fromDemo).toBeNull();
  });
});

describe('getActiveCategoriesForEngineer', () => {
  it('возвращает только не-просроченные категории; бессрочные — активные', async () => {
    // Активная (valid_until в будущем).
    await createAttestation(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      category: TEST_CATEGORY_A,
      issuedAt: isoOffset(-30),
      validUntil: isoOffset(60),
      notes: `${TEST_PREFIX}active`,
    });
    // Бессрочная (valid_until = NULL).
    await createAttestation(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      category: TEST_CATEGORY_B,
      issuedAt: isoOffset(-200),
      validUntil: null,
      notes: `${TEST_PREFIX}forever`,
    });
    // Просроченная.
    await createAttestation(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      category: 'Стоматологическое оборудование',
      issuedAt: isoOffset(-400),
      validUntil: isoOffset(-30),
      notes: `${TEST_PREFIX}expired`,
    });

    const active = await getActiveCategoriesForEngineer(getDb(), erfolgId, erfolgEngineerId);
    expect(active).toContain(TEST_CATEGORY_A);
    expect(active).toContain(TEST_CATEGORY_B);
    expect(active).not.toContain('Стоматологическое оборудование');
  });
});

describe('softDeleteAttestation', () => {
  it('после удаления не виден в list, но есть в БД с deleted_at', async () => {
    const created = await createAttestation(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      category: TEST_CATEGORY_A,
      issuedAt: todayIso(),
      notes: `${TEST_PREFIX}softdel`,
    });
    const ok = await softDeleteAttestation(getDb(), erfolgId, created.id);
    expect(ok).toBe(true);

    const list = await listAttestations(getDb(), erfolgId);
    expect(list.find((r) => r.id === created.id)).toBeUndefined();

    // В БД строка остаётся (для аудита/восстановления).
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(engineerAttestations).where(eq(engineerAttestations.id, created.id)),
    );
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();
  });
});

describe('updateAttestation — установка validUntil в прошлое аннулирует допуск', () => {
  it('после update getActiveCategories больше не возвращает категорию', async () => {
    const created = await createAttestation(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      category: TEST_CATEGORY_A,
      issuedAt: isoOffset(-30),
      validUntil: isoOffset(60),
      notes: `${TEST_PREFIX}revoke`,
    });
    let active = await getActiveCategoriesForEngineer(getDb(), erfolgId, erfolgEngineerId);
    expect(active).toContain(TEST_CATEGORY_A);

    // Аннулируем — ставим validUntil вчера.
    await updateAttestation(getDb(), erfolgId, created.id, {
      validUntil: isoOffset(-1),
    });

    active = await getActiveCategoriesForEngineer(getDb(), erfolgId, erfolgEngineerId);
    expect(active).not.toContain(TEST_CATEGORY_A);
  });
});

describe('checkAttestationForAssignment + createTicketCmd warning', () => {
  it('asset c required без аттестации у инженера → warning не null', async () => {
    // Asset требует категорию A, у инженера её нет.
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .update(assets)
        .set({ requiredAttestationCategory: TEST_CATEGORY_A })
        .where(eq(assets.id, erfolgAssetId)),
    );

    const warn = await checkAttestationForAssignment(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      requiredCategory: TEST_CATEGORY_A,
    });
    expect(warn).not.toBeNull();
    expect(warn).toMatch(/аттестации/i);

    // Через создание заявки с инженером — тоже warning.
    const ctx = makeCmdCtx(erfolgId, erfolgDispatcherId);
    const result = await createTicketCmd(ctx, {
      clientId: erfolgClientId,
      assetId: erfolgAssetId,
      assignedEngineerId: erfolgEngineerId,
      symptom: `${TEST_PREFIX}warn`,
    });
    expect(result.attestationWarning).not.toBeNull();
    expect(result.attestationWarning).toMatch(/аттестации/i);
  });

  it('asset c required + у инженера есть аттестация → warning = null', async () => {
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .update(assets)
        .set({ requiredAttestationCategory: TEST_CATEGORY_A })
        .where(eq(assets.id, erfolgAssetId)),
    );
    await createAttestation(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      category: TEST_CATEGORY_A,
      issuedAt: isoOffset(-30),
      validUntil: isoOffset(335),
      notes: `${TEST_PREFIX}has-attest`,
    });

    const warn = await checkAttestationForAssignment(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      requiredCategory: TEST_CATEGORY_A,
    });
    expect(warn).toBeNull();

    const ctx = makeCmdCtx(erfolgId, erfolgDispatcherId);
    const result = await createTicketCmd(ctx, {
      clientId: erfolgClientId,
      assetId: erfolgAssetId,
      assignedEngineerId: erfolgEngineerId,
      symptom: `${TEST_PREFIX}ok`,
    });
    expect(result.attestationWarning).toBeNull();
  });

  it('asset без required → warning всегда null, даже без аттестации', async () => {
    // requiredAttestationCategory сброшен в clearTestData (NULL).
    const warn = await checkAttestationForAssignment(getDb(), erfolgId, {
      engineerId: erfolgEngineerId,
      requiredCategory: null,
    });
    expect(warn).toBeNull();

    const ctx = makeCmdCtx(erfolgId, erfolgDispatcherId);
    const result = await createTicketCmd(ctx, {
      clientId: erfolgClientId,
      assetId: erfolgAssetId,
      assignedEngineerId: erfolgEngineerId,
      symptom: `${TEST_PREFIX}no-required`,
    });
    expect(result.attestationWarning).toBeNull();
  });
});
