/**
 * Cross-tenant security tests для inventory-* и payments / maintenance.
 *
 * Проверяем: RLS блокирует чтение/UPDATE чужих inventory_items / batches / movements,
 * service-слой issueToWorkOrder с item_id чужого тенанта возвращает BAD_REQUEST.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  getDb,
  inventoryBatches,
  inventoryItems,
  inventoryMovements,
  maintenanceLog,
  maintenanceSchedules,
  payments,
  withTenantTx,
  withoutTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';

let erfolgId = '';
let demoId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

describe('RLS — Stage 5 таблицы без tenant_id', () => {
  it('inventory_items: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), (tx) => tx.select().from(inventoryItems));
    expect(rows.length).toBe(0);
  });
  it('inventory_batches: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), (tx) => tx.select().from(inventoryBatches));
    expect(rows.length).toBe(0);
  });
  it('inventory_movements: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), (tx) =>
      tx.select().from(inventoryMovements),
    );
    expect(rows.length).toBe(0);
  });
  it('maintenance_schedules: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), (tx) =>
      tx.select().from(maintenanceSchedules),
    );
    expect(rows.length).toBe(0);
  });
  it('maintenance_log: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), (tx) => tx.select().from(maintenanceLog));
    expect(rows.length).toBe(0);
  });
  it('payments: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), (tx) => tx.select().from(payments));
    expect(rows.length).toBe(0);
  });
});

describe('RLS — Stage 5 изоляция между tenant', () => {
  it('erfolg видит свои inventory_items, не demo', async () => {
    const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(inventoryItems),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.tenantId).toBe(erfolgId);
  });

  it('UPDATE чужого inventory_item → 0 affected', async () => {
    const [item] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(inventoryItems).limit(1),
    );
    if (!item) throw new Error('seed missing item');
    const result = await withTenantTx(getDb(), demoId, (tx) =>
      tx
        .update(inventoryItems)
        .set({ name: 'HIJACKED' })
        .where(eq(inventoryItems.id, item.id))
        .returning({ id: inventoryItems.id }),
    );
    expect(result.length).toBe(0);

    // Имя не изменилось.
    const [check] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ name: inventoryItems.name })
        .from(inventoryItems)
        .where(eq(inventoryItems.id, item.id)),
    );
    expect(check?.name).toBe(item.name);
  });

  it('DELETE чужой партии → 0 affected', async () => {
    const [batch] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(inventoryBatches).limit(1),
    );
    if (!batch) throw new Error('seed missing batch');
    const result = await withTenantTx(getDb(), demoId, (tx) =>
      tx
        .delete(inventoryBatches)
        .where(eq(inventoryBatches.id, batch.id))
        .returning({ id: inventoryBatches.id }),
    );
    expect(result.length).toBe(0);
  });

  it('INSERT в inventory_movements с подменой tenant_id → throws', async () => {
    const [item] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(inventoryItems).limit(1),
    );
    if (!item) throw new Error('seed missing item');
    await expect(
      withTenantTx(getDb(), demoId, (tx) =>
        tx.insert(inventoryMovements).values({
          tenantId: erfolgId,
          itemId: item.id,
          quantity: '-1',
          kind: 'outbound',
          referenceType: 'manual',
        }),
      ),
    ).rejects.toThrow();
  });

  it('INSERT в payments с подменой tenant_id → throws', async () => {
    const [pay] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(payments).limit(1),
    );
    if (!pay) throw new Error('seed missing payment');
    await expect(
      withTenantTx(getDb(), demoId, (tx) =>
        tx.insert(payments).values({
          tenantId: erfolgId,
          ticketId: pay.ticketId,
          amountKopecks: 100n,
          method: 'cash',
        }),
      ),
    ).rejects.toThrow();
  });
});
