/**
 * Отметку «ТО выполнено» инженер ставит только на СВОЁМ графике.
 *
 * Решение владельца 2026-08-11 («ограничить»): раньше recordPerformed был
 * engineerProcedure без единой проверки — любой инженер отмечал выполнение
 * на любом графике любой техники (и даже без графика, разовой записью).
 *
 * Правило: staff — как раньше (любые отметки, в т.ч. разовые без графика);
 * инженер — только по графику, где он ответственный (responsible_user_id).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import {
  assets,
  getDb,
  maintenanceLog,
  maintenanceSchedules,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createSchedule } from '../modules/maintenance/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-MAINT-OWN-';

let erfolgId = '';
let assetId = '';
let engineerId = '';
let dispatcherId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [a] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: assets.id }).from(assets).limit(1),
  );
  if (!a) throw new Error('seed missing asset');
  assetId = a.id;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const eng = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!eng || !disp) throw new Error('seed missing engineer/dispatcher');
  engineerId = eng.id;
  dispatcherId = disp.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(maintenanceLog).where(like(maintenanceLog.summary, `${TEST_PREFIX}%`));
    await tx
      .delete(maintenanceSchedules)
      .where(like(maintenanceSchedules.notes, `${TEST_PREFIX}%`));
  });
});

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(role: 'dispatcher' | 'engineer'): Context {
  const session: SessionData = {
    tenantId: erfolgId,
    userId: role === 'engineer' ? engineerId : dispatcherId,
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

async function makeSchedule(responsibleUserId: string | null): Promise<string> {
  const { id } = await createSchedule(getDb(), erfolgId, {
    assetId,
    kind: 'planned',
    intervalDays: 90,
    responsibleUserId,
    notes: `${TEST_PREFIX}schedule`,
  });
  return id;
}

const recordInput = (scheduleId: string | null) => ({
  assetId,
  scheduleId,
  summary: `${TEST_PREFIX}выполнено`,
});

describe('отметка ТО — принадлежность графика', () => {
  it('инженер НЕ может отметить чужой график (ответственный другой)', async () => {
    const scheduleId = await makeSchedule(dispatcherId);
    const engineer = appRouter.createCaller(makeCtx('engineer'));
    await expect(engineer.maintenance.recordPerformed(recordInput(scheduleId))).rejects.toThrow(
      /ответственн/i,
    );
  });

  it('инженер НЕ может отметить график без ответственного', async () => {
    const scheduleId = await makeSchedule(null);
    const engineer = appRouter.createCaller(makeCtx('engineer'));
    await expect(engineer.maintenance.recordPerformed(recordInput(scheduleId))).rejects.toThrow(
      /ответственн/i,
    );
  });

  it('инженер НЕ может сделать разовую отметку без графика', async () => {
    const engineer = appRouter.createCaller(makeCtx('engineer'));
    await expect(engineer.maintenance.recordPerformed(recordInput(null))).rejects.toThrow(
      /ответственн/i,
    );
  });

  it('свой график (инженер — ответственный) — отметка проходит', async () => {
    const scheduleId = await makeSchedule(engineerId);
    const engineer = appRouter.createCaller(makeCtx('engineer'));
    const res = await engineer.maintenance.recordPerformed(recordInput(scheduleId));
    expect(res.id).toBeTruthy();
  });

  it('диспетчер — как раньше: любой график и разовая отметка без графика', async () => {
    const scheduleId = await makeSchedule(engineerId);
    const dispatcher = appRouter.createCaller(makeCtx('dispatcher'));
    await expect(
      dispatcher.maintenance.recordPerformed(recordInput(scheduleId)),
    ).resolves.toBeTruthy();
    await expect(dispatcher.maintenance.recordPerformed(recordInput(null))).resolves.toBeTruthy();
  });
});
