/**
 * Тесты модуля repair-archive (AI-диагностика по симптому).
 *
 * 1. searchSimilar по симптому — находит ремонт с совпадающим ключевым словом, не находит чужой.
 * 2. searchSimilar по симптому + модели — matchReason 'symptom_model'.
 * 3. searchSimilar по ticketId — сервер достаёт симптом+модель из заявки.
 * 4. cross-tenant: архив demo не виден из erfolg (RLS).
 * 5. summarize — basedOn > 0 при наличии совпадений (text null без LLM — деградация).
 * 6. RBAC: инженер не может вызвать summarize (LLM за staff).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { assets, clients, getDb, repairArchive, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createAssetWithEvent } from '../modules/assets/repository';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const REF_PREFIX = 'TEST-RA-';

let erfolgId = '';
let demoId = '';
let erfolgClientId = '';
let dispatcherId = '';
let directorId = '';
let engineerId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  const [c1] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c1) throw new Error('seed missing clients');
  erfolgClientId = c1.id;

  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const eng = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  const dir = usrs.find((u) => u.role === 'director');
  if (!eng || !disp) throw new Error('seed missing engineer/dispatcher');
  engineerId = eng.id;
  dispatcherId = disp.id;
  directorId = dir?.id ?? engineerId;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(tickets).where(like(tickets.symptom, `${REF_PREFIX}%`));
      await tx.delete(assets).where(like(assets.model, `${REF_PREFIX}%`));
      await tx.delete(repairArchive).where(like(repairArchive.sourceRef, `${REF_PREFIX}%`));
    });
  }
}

beforeEach(clearTestData);

async function seedArchive(
  tenantId: string,
  rows: Array<{
    sourceRef: string;
    deviceModel?: string | null;
    symptom?: string | null;
    diagnosis?: string | null;
    worksSummary?: string | null;
    year?: number | null;
  }>,
): Promise<void> {
  await withTenantTx(getDb(), tenantId, (tx) =>
    tx.insert(repairArchive).values(rows.map((r) => ({ tenantId, ...r }))),
  );
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(opts: {
  role: 'director' | 'dispatcher' | 'engineer';
  userId?: string;
  tenantId?: string;
}): Context {
  const tid = opts.tenantId ?? erfolgId;
  const userId =
    opts.userId ??
    (opts.role === 'director'
      ? directorId
      : opts.role === 'dispatcher'
        ? dispatcherId
        : engineerId);
  const session: SessionData = {
    tenantId: tid,
    userId,
    username: `${opts.role}-test`,
    role: opts.role,
    fullName: `Test ${opts.role}`,
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: tid,
      subdomain: tid === erfolgId ? 'erfolg' : 'demo',
      displayName: tid === erfolgId ? 'erfolg' : 'demo',
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

describe('repairArchive.searchSimilar / summarize', () => {
  it('по симптому находит совпадение по ключевому слову, чужой ремонт — нет', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await seedArchive(erfolgId, [
      {
        sourceRef: `${REF_PREFIX}A`,
        deviceModel: 'Monitor X100flug',
        symptom: 'Не включается флюгегехаймен экрана',
        diagnosis: 'Сгорел блок питания',
        worksSummary: 'Замена платы питания',
        year: 2021,
      },
      {
        sourceRef: `${REF_PREFIX}B`,
        deviceModel: 'Pump Z9',
        symptom: 'Течёт масло из корпуса',
        diagnosis: 'Износ прокладки',
        year: 2019,
      },
    ]);

    const found = await caller.repairArchive.searchSimilar({ symptom: 'флюгегехаймен', limit: 5 });
    const refs = found.map((m) => m.sourceRef);
    expect(refs).toContain(`${REF_PREFIX}A`);
    expect(refs).not.toContain(`${REF_PREFIX}B`);
    const a = found.find((m) => m.sourceRef === `${REF_PREFIX}A`);
    expect(a?.matchReason).toBe('symptom');
    expect(a?.diagnosis).toBe('Сгорел блок питания');
  });

  it('по симптому + модели — matchReason symptom_model, совпадение первое', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await seedArchive(erfolgId, [
      {
        sourceRef: `${REF_PREFIX}A`,
        deviceModel: 'Monitor X100flug',
        symptom: 'Не включается флюгегехаймен экрана',
        year: 2021,
      },
    ]);

    const found = await caller.repairArchive.searchSimilar({
      symptom: 'флюгегехаймен',
      model: 'Monitor X100flug',
      limit: 5,
    });
    expect(found[0]?.sourceRef).toBe(`${REF_PREFIX}A`);
    expect(found[0]?.matchReason).toBe('symptom_model');
  });

  it('по ticketId — сервер достаёт симптом и модель заявки', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));

    const { id: assetId } = await createAssetWithEvent(getDb(), erfolgId, dispatcherId, {
      ownerClientId: erfolgClientId,
      model: `${REF_PREFIX}DragerSavina300`,
      manufacturer: 'Drager',
      serialNumber: null,
      inventoryNumber: null,
      location: null,
      riskClass: null,
      commissionedAt: null,
      warrantyUntil: null,
      notes: null,
    });
    const { id: ticketId } = await createTicket(getDb(), erfolgId, dispatcherId, {
      clientId: erfolgClientId,
      assetId,
      symptom: `${REF_PREFIX}зумблификатор экран`,
    });

    await seedArchive(erfolgId, [
      {
        sourceRef: `${REF_PREFIX}C`,
        deviceModel: `${REF_PREFIX}DragerSavina300`,
        symptom: 'зумблификатор экран не включается',
        diagnosis: 'плата управления',
        worksSummary: 'Замена платы',
        year: 2020,
      },
    ]);

    const found = await caller.repairArchive.searchSimilar({ ticketId, limit: 5 });
    const c = found.find((m) => m.sourceRef === `${REF_PREFIX}C`);
    expect(c).toBeDefined();
    expect(c?.matchReason).toBe('symptom_model');
  });

  it('cross-tenant: архив demo не виден из erfolg', async () => {
    await seedArchive(demoId, [
      {
        sourceRef: `${REF_PREFIX}DEMO`,
        deviceModel: 'DemoModel',
        symptom: 'демоункальное слово неисправность',
        year: 2020,
      },
    ]);
    const erfolgCaller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const found = await erfolgCaller.repairArchive.searchSimilar({
      symptom: 'демоункальное',
      limit: 5,
    });
    expect(found.find((m) => m.sourceRef === `${REF_PREFIX}DEMO`)).toBeUndefined();
  });

  it('summarize: basedOn отражает число совпадений (text может быть null без LLM)', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await seedArchive(erfolgId, [
      {
        sourceRef: `${REF_PREFIX}A`,
        deviceModel: 'Monitor X100flug',
        symptom: 'Не включается флюгегехаймен экрана',
        diagnosis: 'Блок питания',
        year: 2021,
      },
    ]);

    const res = await caller.repairArchive.summarize({ symptom: 'флюгегехаймен' });
    expect(res.basedOn).toBeGreaterThanOrEqual(1);
    // text — либо строка (если LLM настроен), либо null (деградация). Оба валидны.
    expect(res.text === null || typeof res.text === 'string').toBe(true);
  });

  it('summarize без совпадений → text null, basedOn 0', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const res = await caller.repairArchive.summarize({ symptom: 'несуществующийсимптомъзжх' });
    expect(res.basedOn).toBe(0);
    expect(res.text).toBeNull();
  });

  it('RBAC: инженер не может вызвать summarize (LLM за staff)', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expect(
      caller.repairArchive.summarize({ symptom: 'флюгегехаймен' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
