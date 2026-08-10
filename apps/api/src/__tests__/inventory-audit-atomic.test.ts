/**
 * Аудит складского движения — в ТОЙ ЖЕ транзакции, что и само движение.
 *
 * ЧТО БЫЛО. Списание/возврат коммитились СВОЕЙ транзакцией, а запись в журнал
 * действий шла следом отдельной. Сбой журнала превращал УДАВШЕЕСЯ списание в
 * ошибку для человека — а текст ошибки ещё и советовал «попробуйте ещё раз».
 * Повтор = вторая запчасть со склада: движение не идемпотентно.
 *
 * ТЕПЕРЬ. Движение и журнал — одна транзакция: упал журнал → откатилось
 * движение, «ошибка» на экране означает «ничего не произошло», и повтор
 * безопасен. Для денежных и складских операций журнал обязателен по смыслу
 * (402-ФЗ): нет записи в журнале — нет операции.
 *
 * Журнал здесь ломается подменой модуля аудита; обе формы (writeAudit и
 * writeAuditInTx) бросают — тест не зависит от того, какой из них зовёт сервис.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  inventoryBatches,
  inventoryItems,
  inventoryMovements,
  tickets,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import {
  issueToWorkOrderCmd,
  returnFromWorkOrderCmd,
} from '../modules/inventory-movements/service';
import { issueToWorkOrder } from '../modules/inventory-movements/repository';
import type { CmdCtx } from '../trpc/helpers';

vi.mock('../lib/audit', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/audit')>();
  const broken = async () => {
    throw new Error('журнал недоступен (тест)');
  };
  return { ...orig, writeAudit: vi.fn(broken), writeAuditInTx: vi.fn(broken) };
});

const TEST_PREFIX = 'TEST-AUDIT-ATOMIC-';

let erfolgId = '';
let clientId = '';
let actingUserId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
  const [u] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).limit(1),
  );
  if (!u) throw new Error('seed missing user');
  actingUserId = u.id;
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
    // Диспетчер: проверка «своя ли заявка» не мешает сути теста.
    session: { userId: actingUserId, role: 'dispatcher' },
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

async function remainingOf(batchId: string): Promise<string> {
  const [b] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ q: inventoryBatches.quantityRemaining })
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, batchId)),
  );
  return String(b?.q);
}

async function movementsOf(itemId: string): Promise<number> {
  const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.itemId, itemId)),
  );
  return rows.length;
}

describe('журнал упал — складское движение откатывается', () => {
  it('списание: остаток и движения нетронуты, ошибка честная', async () => {
    const { itemId, batchId, lineId } = await setup();

    await expect(
      issueToWorkOrderCmd(ctx(), { workOrderLineId: lineId, itemId, quantity: '2' }),
    ).rejects.toThrow(/журнал недоступен/);

    // Ничего не произошло — «ошибка» на экране не врёт, повтор безопасен.
    expect(await remainingOf(batchId)).toBe('10.000');
    expect(await movementsOf(itemId)).toBe(0);
  });

  it('возврат: остаток и движения нетронуты', async () => {
    const { itemId, batchId, lineId } = await setup();
    // Списываем 2 напрямую через репозиторий (мимо журнала) — есть что возвращать.
    await issueToWorkOrder(getDb(), erfolgId, {
      workOrderLineId: lineId,
      itemId,
      quantity: '2',
      userId: null,
    });
    expect(await remainingOf(batchId)).toBe('8.000');
    const movementsAfterIssue = await movementsOf(itemId);

    await expect(
      returnFromWorkOrderCmd(ctx(), { workOrderLineId: lineId, itemId, quantity: '1' }),
    ).rejects.toThrow(/журнал недоступен/);

    expect(await remainingOf(batchId)).toBe('8.000');
    expect(await movementsOf(itemId)).toBe(movementsAfterIssue);
  });
});
