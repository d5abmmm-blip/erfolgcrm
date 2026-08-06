/**
 * Тесты модуля kb-articles.
 *
 * 1. searchSimilar по assetId — статья с совпадением asset_models первая.
 * 2. searchSimilar по ticketId — учитывает model тикетного asset.
 * 3. cross-tenant: статья из demo не виден из erfolg, попытка get → NOT_FOUND.
 * 4. archived статья не показывается в list/searchSimilar без includeArchived.
 * 5. trigram-ранжирование: точное совпадение в title даёт максимальный similarity.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { assets, clients, getDb, kbArticles, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createAssetWithEvent } from '../modules/assets/repository';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-KB-';

let erfolgId = '';
let demoId = '';
let erfolgClientId = '';
let demoClientId = '';
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
  const [c2] = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c1 || !c2) throw new Error('seed missing clients');
  erfolgClientId = c1.id;
  demoClientId = c2.id;

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
      // Сначала тикеты (они ссылаются на assets), потом assets, потом статьи.
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
      await tx.delete(assets).where(like(assets.model, `${TEST_PREFIX}%`));
      await tx.delete(kbArticles).where(like(kbArticles.title, `${TEST_PREFIX}%`));
    });
  }
}

beforeEach(clearTestData);

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

describe('kbArticles.list / get / searchSimilar', () => {
  it('searchSimilar по assetId — статья c совпадением asset_models приоритет', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));

    // Создаём asset
    const { id: assetId } = await createAssetWithEvent(getDb(), erfolgId, dispatcherId, {
      ownerClientId: erfolgClientId,
      model: `${TEST_PREFIX}TonometrXYZ`,
      manufacturer: 'Omron',
      serialNumber: null,
      inventoryNumber: null,
      location: null,
      riskClass: null,
      commissionedAt: null,
      warrantyUntil: null,
      notes: null,
    });

    // 1) Статья по модели — должна быть найдена через assetModels.
    const byModel = await caller.kbArticles.create({
      title: `${TEST_PREFIX}Калибровка тонометра XYZ`,
      body: 'Шаги калибровки манжеты и сенсора давления.',
      tags: ['калибровка'],
      assetModels: [`${TEST_PREFIX}TonometrXYZ`],
      attachedAssetIds: [],
    });

    // 2) Статья никак не связанная.
    await caller.kbArticles.create({
      title: `${TEST_PREFIX}Замена ИВЛ-фильтра`,
      body: 'Совершенно другая тема.',
      tags: ['ивл'],
      assetModels: [],
      attachedAssetIds: [],
    });

    const found = await caller.kbArticles.searchSimilar({ assetId, limit: 5 });
    expect(found.length).toBeGreaterThanOrEqual(1);
    const first = found[0];
    expect(first?.id).toBe(byModel.id);
    expect(first?.matchReason).toBe('model');
  });

  it('searchSimilar по ticketId — учитывает model асcета и symptom', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));

    const { id: assetId } = await createAssetWithEvent(getDb(), erfolgId, dispatcherId, {
      ownerClientId: erfolgClientId,
      model: `${TEST_PREFIX}DragerSavina300`,
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
      symptom: `${TEST_PREFIX}не включается экран`,
    });

    // Статья по модели Drager
    const byModel = await caller.kbArticles.create({
      title: `${TEST_PREFIX}Тех. подсказки Drager Savina`,
      body: 'Особенности экрана и диагностики.',
      tags: ['ивл'],
      assetModels: [`${TEST_PREFIX}DragerSavina300`],
      attachedAssetIds: [],
    });

    const found = await caller.kbArticles.searchSimilar({ ticketId, limit: 5 });
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.some((a) => a.id === byModel.id)).toBe(true);
  });

  it('cross-tenant: статья demo не видна из erfolg', async () => {
    const demoCaller = appRouter.createCaller(makeCtx({ role: 'dispatcher', tenantId: demoId }));
    const erfolgCaller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));

    // ВАЖНО: для demo используем demoClientId — иначе foreign key упадёт
    void demoClientId; // (мы не создаём asset/ticket в demo, статья без FK)

    const tpl = await demoCaller.kbArticles.create({
      title: `${TEST_PREFIX}DemoOnly`,
      body: 'Текст в demo tenant',
      tags: [],
      assetModels: [],
      attachedAssetIds: [],
    });

    await expect(erfolgCaller.kbArticles.get({ id: tpl.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // searchSimilar по query из текста demo-статьи в erfolg-tenant — не должна находиться.
    const found = await erfolgCaller.kbArticles.searchSimilar({
      query: 'DemoOnly',
      limit: 5,
    });
    expect(found.find((a) => a.id === tpl.id)).toBeUndefined();
  });

  it('archived статья не показывается в list/searchSimilar по умолчанию', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));

    const a = await caller.kbArticles.create({
      title: `${TEST_PREFIX}ToArchive`,
      body: 'Будет архивирована',
      tags: ['архивный'],
      assetModels: [`${TEST_PREFIX}ArchModel`],
      attachedAssetIds: [],
    });
    await caller.kbArticles.archive({ id: a.id });

    const visible = await caller.kbArticles.list({});
    expect(visible.find((x) => x.id === a.id)).toBeUndefined();

    const all = await caller.kbArticles.list({ includeArchived: true });
    expect(all.find((x) => x.id === a.id)?.archivedAt).not.toBeNull();

    // searchSimilar тоже не должен находить (репо фильтрует по includeArchived: false).
    const found = await caller.kbArticles.searchSimilar({
      query: `${TEST_PREFIX}ToArchive`,
      limit: 5,
    });
    expect(found.find((x) => x.id === a.id)).toBeUndefined();

    // unarchive возвращает в выдачу.
    await caller.kbArticles.unarchive({ id: a.id });
    const afterUnarchive = await caller.kbArticles.list({});
    expect(afterUnarchive.find((x) => x.id === a.id)?.archivedAt).toBeNull();
  });

  it('trigram-поиск: статья с совпадающим текстом находится, нерелевантная — нет', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));

    // Совпадающая статья — все триграммы запроса есть в заголовке.
    const matching = await caller.kbArticles.create({
      title: `${TEST_PREFIX}Замена термопасты на материнской плате`,
      body: 'Использовать MX-4 или Arctic Silver. Тонким слоем.',
      tags: [],
      assetModels: [],
      attachedAssetIds: [],
    });

    // Несвязанная — ни заголовок, ни тело не пересекается с запросом.
    const unrelated = await caller.kbArticles.create({
      title: `${TEST_PREFIX}Поверка манометров`,
      body: 'Документация по госповерке давления.',
      tags: [],
      assetModels: [],
      attachedAssetIds: [],
    });

    const found = await caller.kbArticles.list({
      query: 'Замена термопасты',
      limit: 10,
    });
    const onlyTest = found.filter((x) => x.title.startsWith(TEST_PREFIX));
    // Совпадающая обязательно найдена.
    expect(onlyTest.find((x) => x.id === matching.id)).toBeDefined();
    // Несвязанная — не должна попасть в выдачу (similarity ниже порога).
    expect(onlyTest.find((x) => x.id === unrelated.id)).toBeUndefined();

    // similarity у найденной — заполнено и > 0.
    const m = onlyTest.find((x) => x.id === matching.id);
    expect(m?.similarity).not.toBeNull();
    expect(m?.similarity ?? 0).toBeGreaterThan(0);
  });
});
