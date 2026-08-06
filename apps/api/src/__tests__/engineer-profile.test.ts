/**
 * Профиль инженера — навыки и занятость.
 *
 * Тесты:
 *   1. setSkills заменяет набор целиком; дедуп case-insensitive.
 *   2. listActiveAvailability учитывает только занятость, актуальную на дату.
 *   3. deleteAvailability убирает запись.
 *   4. Cross-tenant: навыки demo не видны в erfolg (RLS).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, userAvailability, userDeviceSkills, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import {
  listActiveAvailability,
  listSkills as repoListSkills,
} from '../modules/engineer-profile/repository';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let demoId = '';
let engineerId = '';
let demoEngineerId = '';
let dispatcherId = '';
let directorId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  engineerId = usrs.find((u) => u.role === 'engineer')?.id ?? '';
  dispatcherId = usrs.find((u) => u.role === 'dispatcher')?.id ?? '';
  directorId = usrs.find((u) => u.role === 'director')?.id ?? dispatcherId;
  const demoUsrs = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  demoEngineerId = demoUsrs.find((u) => u.role === 'engineer')?.id ?? demoUsrs[0]?.id ?? '';
});

async function clearData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(userDeviceSkills);
      await tx.delete(userAvailability);
    });
  }
}
beforeEach(clearData);

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(role: 'director' | 'dispatcher', tenantId = erfolgId): Context {
  const session: SessionData = {
    tenantId,
    userId: role === 'director' ? directorId : dispatcherId,
    username: `${role}-test`,
    role,
    fullName: `Test ${role}`,
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: tenantId,
      subdomain: tenantId === erfolgId ? 'erfolg' : 'demo',
      displayName: tenantId === erfolgId ? 'erfolg' : 'demo',
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

describe('Профиль инженера: навыки', () => {
  it('setSkills заменяет набор целиком и дедуплицирует', async () => {
    const caller = appRouter.createCaller(makeCtx('director'));
    await caller.engineerProfile.setSkills({
      userId: engineerId,
      deviceTypes: ['УЗИ-аппарат', 'Рентген-аппарат', 'узи-аппарат'],
    });
    let skills = await caller.engineerProfile.listSkills();
    let mine = skills.filter((s) => s.userId === engineerId).map((s) => s.deviceType);
    expect(mine.sort()).toEqual(['Рентген-аппарат', 'УЗИ-аппарат']);

    // Замена целиком
    await caller.engineerProfile.setSkills({
      userId: engineerId,
      deviceTypes: ['Автоклав (стерилизатор)'],
    });
    skills = await caller.engineerProfile.listSkills();
    mine = skills.filter((s) => s.userId === engineerId).map((s) => s.deviceType);
    expect(mine).toEqual(['Автоклав (стерилизатор)']);
  });
});

describe('Профиль инженера: занятость', () => {
  it('listActiveAvailability учитывает диапазон дат', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    await caller.engineerProfile.setAvailability({
      userId: engineerId,
      kind: 'vacation',
      dateFrom: '2026-07-10',
      dateTo: '2026-07-20',
      note: null,
    });
    const inRange = await listActiveAvailability(getDb(), erfolgId, '2026-07-15');
    expect(inRange.some((a) => a.userId === engineerId && a.kind === 'vacation')).toBe(true);
    const outRange = await listActiveAvailability(getDb(), erfolgId, '2026-07-25');
    expect(outRange.some((a) => a.userId === engineerId)).toBe(false);
  });

  it('deleteAvailability убирает запись', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const { id } = await caller.engineerProfile.setAvailability({
      userId: engineerId,
      kind: 'onsite',
      dateFrom: '2026-07-04',
      dateTo: '2026-07-04',
      note: 'Клиника Улыбка',
    });
    let rows = await caller.engineerProfile.listAvailability({ userId: engineerId });
    expect(rows.length).toBe(1);
    await caller.engineerProfile.deleteAvailability({ id });
    rows = await caller.engineerProfile.listAvailability({ userId: engineerId });
    expect(rows.length).toBe(0);
  });
});

describe('Профиль инженера: cross-tenant', () => {
  it('навыки demo не видны в erfolg (RLS)', async () => {
    // Навык в demo напрямую.
    await withTenantTx(getDb(), demoId, (tx) =>
      tx.insert(userDeviceSkills).values({
        tenantId: demoId,
        userId: demoEngineerId,
        deviceType: 'ЭКГ',
      }),
    );
    const erfolgSkills = await repoListSkills(getDb(), erfolgId);
    expect(erfolgSkills.some((s) => s.userId === demoEngineerId)).toBe(false);
    // Проверяем что запись реально существует в demo.
    const demoSkills = await repoListSkills(getDb(), demoId);
    expect(demoSkills.some((s) => s.userId === demoEngineerId)).toBe(true);
    await withTenantTx(getDb(), demoId, (tx) =>
      tx.delete(userDeviceSkills).where(eq(userDeviceSkills.userId, demoEngineerId)),
    );
  });
});
