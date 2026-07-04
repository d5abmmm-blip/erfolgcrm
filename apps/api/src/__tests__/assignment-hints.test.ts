/**
 * Умные подсказки при назначении инженера (engineerProfile.assignmentHints).
 *
 * Тесты:
 *   1. Возвращает загрузку (activeLoad) и навык (hasSkill) под deviceType заявки.
 *   2. Занятость сегодня (availabilityToday) отражается в подсказке.
 *   3. hasSkill=null, когда deviceType не задан (нечего проверять).
 *   4. Доступно staff (dispatcher), НЕ доступно роли engineer (FORBIDDEN).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import {
  clients,
  getDb,
  tickets,
  userAvailability,
  userDeviceSkills,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-HINTS-';
const DEVICE_TYPE = 'УЗИ-аппарат';

let erfolgId = '';
let primaryClientId = '';
let engineerId = '';
let dispatcherId = '';
let directorId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  engineerId = usrs.find((u) => u.role === 'engineer')?.id ?? '';
  dispatcherId = usrs.find((u) => u.role === 'dispatcher')?.id ?? '';
  directorId = usrs.find((u) => u.role === 'director')?.id ?? dispatcherId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client (erfolg)');
  primaryClientId = c.id;
});

async function clearData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    await tx.delete(userDeviceSkills);
    await tx.delete(userAvailability);
  });
}
beforeEach(clearData);

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(role: 'director' | 'dispatcher' | 'engineer'): Context {
  const userId =
    role === 'director' ? directorId : role === 'dispatcher' ? dispatcherId : engineerId;
  const session: SessionData = {
    tenantId: erfolgId,
    userId,
    username: `${role}-test`,
    role,
    fullName: `Test ${role}`,
    expiresAt: Date.now() + 3600_000,
  };
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
    session,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
  };
}

describe('assignmentHints: загрузка и навык', () => {
  it('возвращает activeLoad и hasSkill по deviceType', async () => {
    // Навык под тип техники + активная заявка на инженере.
    const caller = appRouter.createCaller(makeCtx('director'));
    await caller.engineerProfile.setSkills({
      userId: engineerId,
      deviceTypes: [DEVICE_TYPE],
    });
    await createTicket(getDb(), erfolgId, null, {
      clientId: primaryClientId,
      symptom: `${TEST_PREFIX}load`,
      assignedEngineerId: engineerId,
    });

    const hints = await caller.engineerProfile.assignmentHints({ deviceType: DEVICE_TYPE });
    const mine = hints.find((h) => h.userId === engineerId);
    expect(mine).toBeTruthy();
    expect(mine!.activeLoad).toBeGreaterThanOrEqual(1);
    expect(mine!.hasSkill).toBe(true);

    // Инженер без навыка под этот тип получает hasSkill=false.
    const other = hints.find((h) => h.userId !== engineerId);
    if (other) expect(other.hasSkill).toBe(false);
  });

  it('hasSkill=null, когда deviceType не задан', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const hints = await caller.engineerProfile.assignmentHints();
    const mine = hints.find((h) => h.userId === engineerId);
    expect(mine).toBeTruthy();
    expect(mine!.hasSkill).toBeNull();
  });
});

describe('assignmentHints: занятость', () => {
  it('availabilityToday отражает отпуск на сегодня', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    await caller.engineerProfile.setAvailability({
      userId: engineerId,
      kind: 'vacation',
      dateFrom: today,
      dateTo: today,
      note: null,
    });
    const hints = await caller.engineerProfile.assignmentHints({ deviceType: DEVICE_TYPE });
    const mine = hints.find((h) => h.userId === engineerId);
    expect(mine!.availabilityToday).toBe('vacation');
  });
});

describe('assignmentHints: RBAC', () => {
  it('staff (dispatcher) — доступно', async () => {
    const caller = appRouter.createCaller(makeCtx('dispatcher'));
    const hints = await caller.engineerProfile.assignmentHints({ deviceType: null });
    expect(Array.isArray(hints)).toBe(true);
  });

  it('engineer — FORBIDDEN', async () => {
    const caller = appRouter.createCaller(makeCtx('engineer'));
    await expect(
      caller.engineerProfile.assignmentHints({ deviceType: null }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
