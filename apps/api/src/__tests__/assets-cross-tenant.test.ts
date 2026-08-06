/**
 * Cross-tenant security tests for assets и asset_events.
 *
 * Покрывает: чтение/запись/удаление чужих записей, попытка подмены tenant_id,
 * попытка переназначить владельца на клиента из чужого tenant, поиск.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { assetEvents, assets, clients, getDb, withTenantTx, withoutTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { assetsRouter } from '../modules/assets';
import { TRPCError } from '@trpc/server';

let erfolgId = '';
let demoId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

describe('RLS — assets/asset_events без tenant_id', () => {
  it('assets: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(assets));
    expect(rows.length).toBe(0);
  });

  it('asset_events: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(assetEvents));
    expect(rows.length).toBe(0);
  });
});

describe('RLS — assets изолированы по tenant', () => {
  it('erfolg видит свои assets, не demo', async () => {
    const rows = await withTenantTx(getDb(), erfolgId, async (tx) => tx.select().from(assets));
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) expect(a.tenantId).toBe(erfolgId);
  });

  it('UPDATE чужого asset → 0 affected', async () => {
    const [erfolgAsset] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(assets).limit(1),
    );
    if (!erfolgAsset) throw new Error('seed missing');

    const result = await withTenantTx(getDb(), demoId, async (tx) =>
      tx
        .update(assets)
        .set({ notes: 'pwned' })
        .where(eq(assets.id, erfolgAsset.id))
        .returning({ id: assets.id }),
    );
    expect(result.length).toBe(0);
  });

  it('INSERT с подменой tenant_id → throws', async () => {
    const [erfolgClient] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(clients).limit(1),
    );
    if (!erfolgClient) throw new Error('seed missing');

    await expect(
      withTenantTx(getDb(), demoId, async (tx) =>
        tx.insert(assets).values({
          tenantId: erfolgId,
          ownerClientId: erfolgClient.id,
          model: 'Stolen Device',
        }),
      ),
    ).rejects.toThrow();
  });

  it('search assets под demo по серийнику erfolg → пусто', async () => {
    const erfolgSerial = 'MDR-DC30-2021-0017';
    const rows = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(assets).where(eq(assets.serialNumber, erfolgSerial)),
    );
    expect(rows.length).toBe(0);
  });

  it('demo не может удалить asset_events erfolg', async () => {
    const [event] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(assetEvents).limit(1),
    );
    if (!event) throw new Error('seed missing event');
    const result = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.delete(assetEvents).where(eq(assetEvents.id, event.id)).returning({ id: assetEvents.id }),
    );
    expect(result.length).toBe(0);
  });

  it('asset_events чужого asset_id → 0 строк', async () => {
    const [erfolgAsset] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(assets).limit(1),
    );
    if (!erfolgAsset) throw new Error('seed missing');
    const rows = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(assetEvents).where(eq(assetEvents.assetId, erfolgAsset.id)),
    );
    expect(rows.length).toBe(0);
  });

  it('INSERT в asset_events с подмененным tenant_id → throws', async () => {
    const [erfolgAsset] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(assets).limit(1),
    );
    if (!erfolgAsset) throw new Error('seed missing');
    await expect(
      withTenantTx(getDb(), demoId, async (tx) =>
        tx.insert(assetEvents).values({
          tenantId: erfolgId,
          assetId: erfolgAsset.id,
          type: 'note',
          payload: { comment: 'inj' },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('Service: смена ownerClientId на клиента чужого tenant — отвергается', () => {
  it('updateAsset с ownerClientId из demo под erfolg-сессией → BAD_REQUEST', async () => {
    const [erfolgAsset] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(assets).limit(1),
    );
    const [demoClient] = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(clients).limit(1),
    );
    if (!erfolgAsset || !demoClient) throw new Error('seed missing');

    const caller = assetsRouter.createCaller({
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
        userId: '00000000-0000-0000-0000-000000000000',
        username: 'director',
        role: 'director',
        fullName: 'Test',
        expiresAt: Date.now() + 3600_000,
      },
      clientUser: null,
      ip: '127.0.0.1',
      userAgent: 'test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res: {} as any,
    });

    await expect(
      caller.update({
        id: erfolgAsset.id,
        patch: { ownerClientId: demoClient.id },
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});
