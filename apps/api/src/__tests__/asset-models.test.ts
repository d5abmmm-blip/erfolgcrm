/**
 * Тесты каталога моделей техники (asset_models):
 *  - find-or-create по (manufacturer, model), регистронезависимо и с учётом NULL;
 *  - поиск по модели/производителю;
 *  - изоляция по tenant (RLS);
 *  - привязка единицы техники к модели (assets.asset_model_id).
 *
 * Используем repository-функции напрямую — фокус на бизнес-логике, не на tRPC.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { assetModels, assets, clients, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createAssetModel,
  getAssetModel,
  listAssetModels,
  searchAssetModels,
  updateAssetModel,
} from '../modules/asset-models/repository';
import { createAssetWithEvent, getAsset } from '../modules/assets/repository';

let erfolgId = '';
let demoId = '';
let clientId = '';

const PREFIX = 'ZZ-TEST-MODEL';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  const list = await withTenantTx(getDb(), erfolgId, async (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (list.length < 1) throw new Error('seed needs at least 1 client');
  clientId = list[0]!.id;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(assetModels).where(like(assetModels.model, `${PREFIX}%`));
    });
  }
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(assets).where(eq(assets.serialNumber, 'INV-MODEL-LINK-001'));
  });
}

describe('asset_models: каталог моделей', () => {
  beforeEach(async () => {
    await clearTestData();
  });

  it('createAssetModel создаёт новую модель (created=true)', async () => {
    const res = await createAssetModel(getDb(), erfolgId, {
      model: `${PREFIX}-A`,
      manufacturer: 'Acme',
    });
    expect(res.created).toBe(true);
    const m = await getAssetModel(getDb(), erfolgId, res.id);
    expect(m?.model).toBe(`${PREFIX}-A`);
    expect(m?.manufacturer).toBe('Acme');
  });

  it('повторное создание (другой регистр) → находит существующую, не плодит дубль', async () => {
    const first = await createAssetModel(getDb(), erfolgId, {
      model: `${PREFIX}-A`,
      manufacturer: 'Acme',
    });
    const second = await createAssetModel(getDb(), erfolgId, {
      model: `${PREFIX.toLowerCase()}-a`,
      manufacturer: 'acme',
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('тот же model, другой производитель → отдельная модель', async () => {
    const a = await createAssetModel(getDb(), erfolgId, {
      model: `${PREFIX}-A`,
      manufacturer: 'Acme',
    });
    const b = await createAssetModel(getDb(), erfolgId, {
      model: `${PREFIX}-A`,
      manufacturer: 'Other',
    });
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it('NULL-производитель: повторное создание без производителя → не дублируется', async () => {
    const a = await createAssetModel(getDb(), erfolgId, { model: `${PREFIX}-B` });
    const b = await createAssetModel(getDb(), erfolgId, { model: `${PREFIX}-B` });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it('поиск находит по модели и по производителю', async () => {
    await createAssetModel(getDb(), erfolgId, {
      model: `${PREFIX}-Ультра`,
      manufacturer: 'Mindray',
    });
    const byModel = await searchAssetModels(getDb(), erfolgId, `${PREFIX}-Ультра`);
    expect(byModel.some((m) => m.model === `${PREFIX}-Ультра`)).toBe(true);

    const byManu = await searchAssetModels(getDb(), erfolgId, 'Mindray');
    expect(byManu.some((m) => m.model === `${PREFIX}-Ультра`)).toBe(true);
  });

  it('поиск регистронезависим для кириллицы', async () => {
    await createAssetModel(getDb(), erfolgId, { model: `${PREFIX}-Улыбка` });
    const found = await searchAssetModels(getDb(), erfolgId, `${PREFIX.toLowerCase()}-улыбка`);
    expect(found.some((m) => m.model === `${PREFIX}-Улыбка`)).toBe(true);
  });

  it('update меняет поля', async () => {
    const { id } = await createAssetModel(getDb(), erfolgId, { model: `${PREFIX}-C` });
    const ok = await updateAssetModel(getDb(), erfolgId, id, {
      manufacturer: 'NewVendor',
      riskClass: '2b',
    });
    expect(ok).toBe(true);
    const m = await getAssetModel(getDb(), erfolgId, id);
    expect(m?.manufacturer).toBe('NewVendor');
    expect(m?.riskClass).toBe('2b');
  });

  it('изоляция tenant: модель erfolg не видна в demo', async () => {
    const { id } = await createAssetModel(getDb(), erfolgId, { model: `${PREFIX}-ISO` });
    const fromDemo = await getAssetModel(getDb(), demoId, id);
    expect(fromDemo).toBeNull();
    const searchDemo = await searchAssetModels(getDb(), demoId, `${PREFIX}-ISO`);
    expect(searchDemo.length).toBe(0);
  });

  it('list возвращает созданные модели (без soft-deleted)', async () => {
    await createAssetModel(getDb(), erfolgId, { model: `${PREFIX}-L1` });
    await createAssetModel(getDb(), erfolgId, { model: `${PREFIX}-L2` });
    const res = await listAssetModels(getDb(), erfolgId, { search: PREFIX });
    const models = res.items.map((m) => m.model);
    expect(models).toContain(`${PREFIX}-L1`);
    expect(models).toContain(`${PREFIX}-L2`);
  });

  it('единица техники хранит ссылку на модель (asset_model_id)', async () => {
    const { id: modelId } = await createAssetModel(getDb(), erfolgId, {
      model: `${PREFIX}-LINKED`,
      manufacturer: 'Drager',
    });
    const { id: assetId } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: clientId,
      assetModelId: modelId,
      model: `${PREFIX}-LINKED`,
      manufacturer: 'Drager',
      serialNumber: 'INV-MODEL-LINK-001',
    });
    const a = await getAsset(getDb(), erfolgId, assetId);
    expect(a?.assetModelId).toBe(modelId);
  });
});
