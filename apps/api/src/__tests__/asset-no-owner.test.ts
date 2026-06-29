/**
 * Техника без привязки к клиенту (миграция 0059).
 *
 * Главное, что проверяем: после снятия NOT NULL с owner_client_id единицу техники
 * можно завести БЕЗ клиента, и она по-прежнему видна в карточке и списке —
 * то есть leftJoin (а не innerJoin) на clients действительно работает.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { assetEvents, assets, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createAssetWithEvent,
  getAsset,
  listAssets,
} from '../modules/assets/repository';

let erfolgId = '';
const createdIds: string[] = [];
const UNIQUE_MODEL = 'TEST No-Owner Аппарат 0059';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

afterAll(async () => {
  // Чистим за собой: события сначала (нет каскада), потом сами assets.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    for (const id of createdIds) {
      await tx.delete(assetEvents).where(eq(assetEvents.assetId, id));
      await tx.delete(assets).where(eq(assets.id, id));
    }
  });
});

describe('Техника без клиента-владельца', () => {
  it('создаётся с ownerClientId = null', async () => {
    const { id } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: null,
      model: UNIQUE_MODEL,
      serialNumber: 'TEST-NO-OWNER-0059',
    });
    createdIds.push(id);
    expect(id).toBeTruthy();
  });

  it('карточка открывается, владелец пустой', async () => {
    const id = createdIds[0]!;
    const a = await getAsset(getDb(), erfolgId, id);
    expect(a).not.toBeNull();
    expect(a!.model).toBe(UNIQUE_MODEL);
    expect(a!.ownerClientId).toBeNull();
    expect(a!.ownerDisplayName).toBeNull();
  });

  it('попадает в список (leftJoin, не теряется)', async () => {
    const { items } = await listAssets(getDb(), erfolgId, { search: 'No-Owner Аппарат 0059' });
    const found = items.find((i) => i.id === createdIds[0]);
    expect(found).toBeTruthy();
    expect(found!.ownerClientId).toBeNull();
    expect(found!.ownerDisplayName).toBeNull();
  });
});
