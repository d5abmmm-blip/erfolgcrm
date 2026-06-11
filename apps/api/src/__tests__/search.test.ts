/**
 * Тесты глобального поиска (модуль search):
 *   • поиск по части номера тикета → попадает в tickets.
 *   • поиск по части серийника → попадает в assets.
 *   • cross-tenant: tenant A не видит данные tenant B.
 *   • короткий запрос (<2 символов) → пустой результат, не тратим БД.
 *   • поиск по invoice_number → попадает в invoices.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import {
  assets,
  clients,
  getDb,
  invoices,
  payments,
  tickets,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { searchEverything } from '../modules/search';
import { createTicket } from '../modules/tickets/repository';
import {
  getOrCreateWorkOrder,
  upsertLine,
} from '../modules/work-orders/repository';
import { createDraft, transitionToIssued } from '../modules/invoices/repository';

let erfolgId = '';
let demoId = '';
let primaryClientId = '';
let demoClientId = '';

const TEST_PREFIX = 'TESTSEARCH-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client erfolg');
  primaryClientId = c.id;
  const [c2] = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c2) throw new Error('seed missing client demo');
  demoClientId = c2.id;
});

afterAll(async () => {
  // Очистим тестовые данные обоих tenant'ов
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(payments).where(like(payments.comment, `${TEST_PREFIX}%`));
      await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
      await tx.delete(assets).where(like(assets.model, `${TEST_PREFIX}%`));
    });
  }
});

beforeEach(async () => {
  // не чистим — пусть тесты сами создают и опираются на свежие данные.
});

async function createTestTicketIn(
  tenantId: string,
  clientId: string,
  symptomTag: string,
): Promise<{ id: string; ticketNumber: string }> {
  const t = await createTicket(getDb(), tenantId, null, {
    clientId,
    symptom: `${TEST_PREFIX}${symptomTag}`,
  });
  return { id: t.id, ticketNumber: t.ticketNumber };
}

async function createTestAssetIn(
  tenantId: string,
  clientId: string,
  serial: string,
): Promise<{ id: string; model: string }> {
  const model = `${TEST_PREFIX}AssetModel-${serial}`;
  return withTenantTx(getDb(), tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO assets (tenant_id, owner_client_id, model, serial_number)
      VALUES (${tenantId}::uuid, ${clientId}::uuid, ${model}, ${serial})
      RETURNING id
    `);
    const newId = (rows as unknown as Array<{ id: string }>)[0]?.id;
    if (!newId) throw new Error('insert asset failed');
    return { id: newId, model };
  });
}

async function createIssuedInvoice(
  tenantId: string,
  clientId: string,
  tag: string,
): Promise<string> {
  const t = await createTicket(getDb(), tenantId, null, {
    clientId,
    symptom: `${TEST_PREFIX}${tag}-inv`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), tenantId, t.id);
  await upsertLine(getDb(), tenantId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}work`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: 100_000n,
  });
  const draft = await createDraft(getDb(), tenantId, {
    workOrderId: wo.id,
    notes: `${TEST_PREFIX}${tag}`,
  });
  const issued = await transitionToIssued(getDb(), tenantId, draft.id, {});
  if (!issued) throw new Error('issue failed');
  return issued.invoiceNumber;
}

describe('searchEverything', () => {
  it('находит заявку по фрагменту номера тикета', async () => {
    const { ticketNumber } = await createTestTicketIn(erfolgId, primaryClientId, 'ticket-by-number');
    // ticketNumber вида T-2026-000123 — берём числовой хвост, он уникален
    const tail = ticketNumber.split('-').pop() ?? ticketNumber;
    const result = await searchEverything(getDb(), erfolgId, tail);
    expect(result.tickets.some((t) => t.ticketNumber === ticketNumber)).toBe(true);
  });

  it('находит технику по фрагменту серийника', async () => {
    const serial = `SN${Date.now()}X`;
    const created = await createTestAssetIn(erfolgId, primaryClientId, serial);
    const result = await searchEverything(getDb(), erfolgId, serial.slice(2, 8));
    expect(result.assets.some((a) => a.id === created.id)).toBe(true);
  });

  it('находит счёт по invoice_number', async () => {
    const invoiceNumber = await createIssuedInvoice(erfolgId, primaryClientId, 'inv-search');
    const result = await searchEverything(getDb(), erfolgId, invoiceNumber);
    expect(result.invoices.some((i) => i.invoiceNumber === invoiceNumber)).toBe(true);
  });

  it('cross-tenant: поиск из tenant A не возвращает данные tenant B', async () => {
    // Создаём тикет в demo с уникальным симптомом
    const uniq = `xtenant-${Date.now()}`;
    const { ticketNumber: demoTicketNumber } = await createTestTicketIn(
      demoId,
      demoClientId,
      uniq,
    );
    // Из erfolg ищем по номеру demo-тикета — RLS должен скрыть.
    const tail = demoTicketNumber.split('-').pop() ?? demoTicketNumber;
    const result = await searchEverything(getDb(), erfolgId, tail);
    expect(result.tickets.some((t) => t.ticketNumber === demoTicketNumber)).toBe(false);
    // А из demo — видит сам себя.
    const own = await searchEverything(getDb(), demoId, tail);
    expect(own.tickets.some((t) => t.ticketNumber === demoTicketNumber)).toBe(true);
  });

  it('query короче 2 символов → пустой результат', async () => {
    const result = await searchEverything(getDb(), erfolgId, 'a');
    expect(result.tickets).toHaveLength(0);
    expect(result.clients).toHaveLength(0);
    expect(result.assets).toHaveLength(0);
    expect(result.invoices).toHaveLength(0);
    expect(result.contracts).toHaveLength(0);

    const empty = await searchEverything(getDb(), erfolgId, '   ');
    expect(empty.tickets).toHaveLength(0);
  });
});

// quiet unused-import lint by referencing eq
void eq;
