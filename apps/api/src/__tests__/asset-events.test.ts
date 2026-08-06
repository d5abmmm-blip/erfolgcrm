/**
 * Тесты на бизнес-инвариант: при изменении lifecycleStatus / ownerClientId / location
 * в assets автоматически появляется asset_event соответствующего типа.
 *
 * Используем service-функции напрямую (а не tRPC caller) — фокус на инварианте.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { assetEvents, assets, clients, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createAssetWithEvent,
  listEvents,
  updateAssetWithEvents,
  addNote,
} from '../modules/assets/repository';

let erfolgId = '';
let demoId = '';
let primaryClientId = '';
let alternateClientId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  void demoId; // не используем тут, но импорт setup общий

  const list = await withTenantTx(getDb(), erfolgId, async (tx) =>
    tx
      .select({ id: clients.id, displayName: clients.displayName })
      .from(clients)
      .orderBy(clients.displayName),
  );
  if (list.length < 2) throw new Error('seed needs at least 2 clients');
  primaryClientId = list[0]!.id;
  alternateClientId = list[1]!.id;
});

async function clearTestAssets(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(assets).where(eq(assets.serialNumber, 'INV-TEST-EVENTS-001'));
  });
}

describe('asset_events: бизнес-инвариант', () => {
  beforeEach(async () => {
    await clearTestAssets();
  });

  it('createAsset → ровно один event "created"', async () => {
    const { id: aid } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: primaryClientId,
      model: 'Test Device',
      serialNumber: 'INV-TEST-EVENTS-001',
    });
    const events = await listEvents(getDb(), erfolgId, aid);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('created');
  });

  it('update только notes → 0 событий', async () => {
    const { id: aid } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: primaryClientId,
      model: 'Test Device',
      serialNumber: 'INV-TEST-EVENTS-001',
    });
    const before = await listEvents(getDb(), erfolgId, aid);
    await updateAssetWithEvents(getDb(), erfolgId, null, aid, { notes: 'hello' });
    const after = await listEvents(getDb(), erfolgId, aid);
    expect(after.length).toBe(before.length);
  });

  it('update lifecycleStatus → один event status_change с from/to', async () => {
    const { id: aid } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: primaryClientId,
      model: 'Test Device',
      serialNumber: 'INV-TEST-EVENTS-001',
      lifecycleStatus: 'in_service',
    });
    await updateAssetWithEvents(getDb(), erfolgId, null, aid, {
      lifecycleStatus: 'in_repair',
    });
    const events = await listEvents(getDb(), erfolgId, aid);
    expect(events.length).toBe(2);
    const top = events[0]!;
    expect(top.type).toBe('status_change');
    expect(top.payload.from).toBe('in_service');
    expect(top.payload.to).toBe('in_repair');
  });

  it('update lifecycleStatus + location за 1 вызов → 2 события', async () => {
    const { id: aid } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: primaryClientId,
      model: 'Test Device',
      serialNumber: 'INV-TEST-EVENTS-001',
      lifecycleStatus: 'in_service',
      location: 'Room A',
    });
    await updateAssetWithEvents(getDb(), erfolgId, null, aid, {
      lifecycleStatus: 'reserve',
      location: 'Room B',
    });
    const events = await listEvents(getDb(), erfolgId, aid);
    // created + 2 update events
    expect(events.length).toBe(3);
    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(['created', 'location_change', 'status_change']);
  });

  it('update ownerClientId → event owner_change', async () => {
    const { id: aid } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: primaryClientId,
      model: 'Test Device',
      serialNumber: 'INV-TEST-EVENTS-001',
    });
    await updateAssetWithEvents(getDb(), erfolgId, null, aid, {
      ownerClientId: alternateClientId,
    });
    const events = await listEvents(getDb(), erfolgId, aid);
    const top = events[0]!;
    expect(top.type).toBe('owner_change');
    expect(top.payload.from).toBe(primaryClientId);
    expect(top.payload.to).toBe(alternateClientId);
  });

  it('addNote → event note с comment, без изменения колонок', async () => {
    const { id: aid } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: primaryClientId,
      model: 'Test Device',
      serialNumber: 'INV-TEST-EVENTS-001',
    });
    const beforeRow = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select({ updatedAt: assets.updatedAt }).from(assets).where(eq(assets.id, aid)).limit(1),
    );
    await addNote(getDb(), erfolgId, null, aid, 'Тестовая заметка');
    const events = await listEvents(getDb(), erfolgId, aid);
    const top = events[0]!;
    expect(top.type).toBe('note');
    expect(top.payload.comment).toBe('Тестовая заметка');
    const afterRow = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select({ updatedAt: assets.updatedAt }).from(assets).where(eq(assets.id, aid)).limit(1),
    );
    // updated_at не должен поменяться — был только insert в asset_events
    expect(afterRow[0]?.updatedAt.getTime()).toBe(beforeRow[0]?.updatedAt.getTime());
  });

  it('events отсортированы newest-first', async () => {
    const { id: aid } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: primaryClientId,
      model: 'Test Device',
      serialNumber: 'INV-TEST-EVENTS-001',
    });
    await new Promise((r) => setTimeout(r, 10));
    await updateAssetWithEvents(getDb(), erfolgId, null, aid, {
      lifecycleStatus: 'in_repair',
    });
    await new Promise((r) => setTimeout(r, 10));
    await addNote(getDb(), erfolgId, null, aid, 'note');

    const events = await listEvents(getDb(), erfolgId, aid);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('note');
    expect(types[types.length - 1]).toBe('created');
    // монотонно убывающие даты
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        events[i]!.createdAt.getTime(),
      );
    }
  });

  it('listEvents в правильном tenant порядке через индекс', async () => {
    // Скорее smoke: добавляет 3 события и проверяет что мы получаем верный assetId
    const { id: aid } = await createAssetWithEvent(getDb(), erfolgId, null, {
      ownerClientId: primaryClientId,
      model: 'Test Device',
      serialNumber: 'INV-TEST-EVENTS-001',
    });
    await addNote(getDb(), erfolgId, null, aid, 'one');
    await addNote(getDb(), erfolgId, null, aid, 'two');
    const events = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx
        .select()
        .from(assetEvents)
        .where(and(eq(assetEvents.assetId, aid)))
        .orderBy(desc(assetEvents.createdAt)),
    );
    expect(events.every((e) => e.assetId === aid)).toBe(true);
    expect(events.length).toBe(3);
  });
});
