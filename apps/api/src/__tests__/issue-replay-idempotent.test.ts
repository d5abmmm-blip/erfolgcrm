/**
 * Реплей офлайн-очереди не списывает запчасть со склада дважды.
 *
 * Сценарий: «Списать со склада» дошло до сервера, партии списаны — а ответ
 * потерялся (мобильная сеть). Клиент кладёт мутацию в очередь, реплей
 * списывал ВТОРОЙ раз: остаток и себестоимость задваивались (ровно те
 * «22 наряда с себестоимостью», где каждая двойная запчасть — прямые деньги).
 *
 * Лечение: клиент передаёт ключ запроса (clientRequestId, uuid) — сервер под
 * advisory-замком проверяет «ключ уже применён?» и повтор не списывает.
 * Разные ключи — независимые списания (легитимная повторная выдача той же
 * запчасти на ту же строку остаётся возможной).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  inventoryBatches,
  inventoryItems,
  inventoryMovements,
  tickets,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { issueToWorkOrderCmd } from '../modules/inventory-movements/service';
import type { CmdCtx } from '../trpc/helpers';

const TEST_PREFIX = 'TEST-ISSUE-REPLAY-';

let erfolgId = '';
let clientId = '';
let dispatcherId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
  const { users } = await import('@erfolg/db');
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!disp) throw new Error('seed missing dispatcher');
  dispatcherId = disp.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    const testItems = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(like(inventoryItems.name, `${TEST_PREFIX}%`));
    for (const item of testItems) {
      await tx.delete(inventoryMovements).where(eq(inventoryMovements.itemId, item.id));
      await tx.delete(inventoryBatches).where(eq(inventoryBatches.itemId, item.id));
    }
    await tx.delete(inventoryItems).where(like(inventoryItems.name, `${TEST_PREFIX}%`));
  });
});

function ctx(): CmdCtx {
  return {
    db: getDb(),
    tenant: { id: erfolgId },
    session: { userId: dispatcherId, role: 'dispatcher' },
    audit: { ip: null, userAgent: null },
  } as unknown as CmdCtx;
}

async function setup(): Promise<{ itemId: string; batchId: string; lineId: string }> {
  const made = await withTenantTx(getDb(), erfolgId, async (tx) => {
    const [item] = await tx
      .insert(inventoryItems)
      .values({ tenantId: erfolgId, name: `${TEST_PREFIX}Плата`, unit: 'шт', minStock: '0' })
      .returning({ id: inventoryItems.id });
    const [batch] = await tx
      .insert(inventoryBatches)
      .values({
        tenantId: erfolgId,
        itemId: item!.id,
        batchCode: 'A',
        quantityInitial: '10',
        quantityRemaining: '10',
        receivedAt: new Date(),
        unitCostKopecks: 50_000n,
      })
      .returning({ id: inventoryBatches.id });
    return { itemId: item!.id, batchId: batch!.id };
  });
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}ticket`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  const line = await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'part',
    name: `${TEST_PREFIX}part`,
    unit: 'шт',
    quantity: '2',
    unitPriceKopecks: 0n,
  });
  return { ...made, lineId: line.id };
}

async function remaining(batchId: string): Promise<string> {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ q: inventoryBatches.quantityRemaining })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, batchId)),
  );
  return row?.q ?? '?';
}

async function outboundCount(itemId: string): Promise<number> {
  const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(
        and(eq(inventoryMovements.itemId, itemId), eq(inventoryMovements.kind, 'outbound')),
      ),
  );
  return rows.length;
}

describe('реплей списания со склада идемпотентен', () => {
  it('повтор с тем же clientRequestId не списывает второй раз', async () => {
    const { itemId, batchId, lineId } = await setup();
    const requestId = crypto.randomUUID();

    const first = await issueToWorkOrderCmd(ctx(), {
      workOrderLineId: lineId,
      itemId,
      quantity: '2',
      clientRequestId: requestId,
    });
    expect(first.consumed.length).toBe(1);

    // Реплей той же записи очереди (ответ первой попытки потерялся).
    await issueToWorkOrderCmd(ctx(), {
      workOrderLineId: lineId,
      itemId,
      quantity: '2',
      clientRequestId: requestId,
    });

    expect(await remaining(batchId)).toBe('8.000');
    expect(await outboundCount(itemId)).toBe(1);
  });

  it('разные ключи — независимые списания (повторная выдача возможна)', async () => {
    const { itemId, batchId, lineId } = await setup();

    await issueToWorkOrderCmd(ctx(), {
      workOrderLineId: lineId,
      itemId,
      quantity: '2',
      clientRequestId: crypto.randomUUID(),
    });
    await issueToWorkOrderCmd(ctx(), {
      workOrderLineId: lineId,
      itemId,
      quantity: '2',
      clientRequestId: crypto.randomUUID(),
    });

    expect(await remaining(batchId)).toBe('6.000');
    expect(await outboundCount(itemId)).toBe(2);
  });

  it('без ключа — как раньше (десктоп и старые записи очереди)', async () => {
    const { itemId, batchId, lineId } = await setup();

    await issueToWorkOrderCmd(ctx(), { workOrderLineId: lineId, itemId, quantity: '2' });
    await issueToWorkOrderCmd(ctx(), { workOrderLineId: lineId, itemId, quantity: '2' });

    expect(await remaining(batchId)).toBe('6.000');
    expect(await outboundCount(itemId)).toBe(2);
  });
});
