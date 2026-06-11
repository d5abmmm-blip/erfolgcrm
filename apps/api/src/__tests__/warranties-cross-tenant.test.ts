/**
 * Гарантии (перенос из v1) — изоляция RLS + вычисляемый статус + stats.
 *
 * Проверяем:
 *   1. Вычисляемый статус: active (>30 дн.), expiring (≤30 дн.), expired (< сегодня), voided.
 *   2. RLS: list/get/archive чужого тенанта не видят гарантию.
 *   3. stats считает по вычисляемому статусу.
 *   4. CHECK end_date >= start_date отклоняет неправильный диапазон.
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { assets, clients, getDb, warranties, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  archiveWarranty,
  createWarranty,
  getWarrantyById,
  listWarranties,
  warrantyStats,
} from '../modules/warranties/repository';

let erfolgId = '';
let demoId = '';
let erfolgAssetId = '';

const TEST_PREFIX = 'TEST-WARR-';

function dateStr(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  // Тестовая техника в erfolg-тенанте (нужен владелец-клиент).
  erfolgAssetId = await withTenantTx(getDb(), erfolgId, async (tx) => {
    const client = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.type, 'legal'))
      .limit(1);
    let clientId = client[0]?.id;
    if (!clientId) {
      const [created] = await tx
        .insert(clients)
        .values({
          tenantId: erfolgId,
          type: 'legal',
          subtype: 'commercial',
          displayName: `${TEST_PREFIX}Owner`,
          status: 'active',
        })
        .returning({ id: clients.id });
      clientId = created!.id;
    }
    const [asset] = await tx
      .insert(assets)
      .values({
        tenantId: erfolgId,
        ownerClientId: clientId,
        model: `${TEST_PREFIX}Analyzer X1`,
        serialNumber: `${TEST_PREFIX}SN1`,
      })
      .returning({ id: assets.id });
    return asset!.id;
  });
});

async function clearTestWarranties(): Promise<void> {
  for (const t of [erfolgId, demoId]) {
    await withTenantTx(getDb(), t, async (tx) => {
      await tx.delete(warranties).where(like(warranties.provider, `${TEST_PREFIX}%`));
    });
  }
}

beforeEach(clearTestWarranties);

// Не оставляем мусор в dev-БД: гарантии + тестовая техника/клиент.
afterAll(async () => {
  await clearTestWarranties();
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(assets).where(like(assets.model, `${TEST_PREFIX}%`));
    await tx.delete(clients).where(like(clients.displayName, `${TEST_PREFIX}%`));
  });
});

describe('warranties — вычисляемый статус', () => {
  it('active / expiring / expired / voided', async () => {
    const mk = (endOffset: number) =>
      createWarranty(getDb(), erfolgId, {
        assetId: erfolgAssetId,
        startDate: dateStr(-100),
        endDate: dateStr(endOffset),
        provider: `${TEST_PREFIX}P`,
      });

    const farFuture = await mk(90); // > today+30 → active
    const soon = await mk(10); // ≤ today+30 → expiring
    const past = await mk(-1); // < today → expired

    expect((await getWarrantyById(getDb(), erfolgId, farFuture.id))?.status).toBe('active');
    expect((await getWarrantyById(getDb(), erfolgId, soon.id))?.status).toBe('expiring');
    expect((await getWarrantyById(getDb(), erfolgId, past.id))?.status).toBe('expired');

    // voided перекрывает даты
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(warranties).set({ voided: true }).where(eq(warranties.id, farFuture.id)),
    );
    expect((await getWarrantyById(getDb(), erfolgId, farFuture.id))?.status).toBe('voided');
  });

  it('фильтр list по вычисляемому статусу', async () => {
    await createWarranty(getDb(), erfolgId, {
      assetId: erfolgAssetId,
      startDate: dateStr(-10),
      endDate: dateStr(5),
      provider: `${TEST_PREFIX}Expiring`,
    });
    const expiring = await listWarranties(getDb(), erfolgId, {
      status: 'expiring',
      search: TEST_PREFIX,
    });
    expect(expiring.items.length).toBe(1);
    expect(expiring.items[0]!.status).toBe('expiring');

    const active = await listWarranties(getDb(), erfolgId, {
      status: 'active',
      search: TEST_PREFIX,
    });
    expect(active.items.length).toBe(0);
  });

  it('stats считает по вычисляемому статусу', async () => {
    const before = await warrantyStats(getDb(), erfolgId);
    await createWarranty(getDb(), erfolgId, {
      assetId: erfolgAssetId,
      startDate: dateStr(-10),
      endDate: dateStr(-2),
      provider: `${TEST_PREFIX}Expired`,
    });
    const after = await warrantyStats(getDb(), erfolgId);
    expect(after.expired).toBe(before.expired + 1);
    expect(after.total).toBe(before.total + 1);
  });
});

describe('warranties — изоляция между тенантами (RLS)', () => {
  it('list/get/archive чужого тенанта не видят гарантию', async () => {
    const { id } = await createWarranty(getDb(), erfolgId, {
      assetId: erfolgAssetId,
      startDate: dateStr(-1),
      endDate: dateStr(365),
      provider: `${TEST_PREFIX}Iso`,
    });

    const demoList = await listWarranties(getDb(), demoId, { search: TEST_PREFIX });
    expect(demoList.items.some((w) => w.id === id)).toBe(false);

    expect(await getWarrantyById(getDb(), demoId, id)).toBeNull();
    expect(await archiveWarranty(getDb(), demoId, id)).toBe(false);

    expect((await getWarrantyById(getDb(), erfolgId, id))?.id).toBe(id);
    expect(await archiveWarranty(getDb(), erfolgId, id)).toBe(true);
  });
});

describe('warranties — инварианты БД', () => {
  it('end_date < start_date отклоняется (CHECK 23514)', async () => {
    await expect(
      createWarranty(getDb(), erfolgId, {
        assetId: erfolgAssetId,
        startDate: dateStr(0),
        endDate: dateStr(-1),
        provider: `${TEST_PREFIX}Bad`,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
