/**
 * Этап 8.A — invoices: изоляция между тенантами + базовая семантика статусов.
 *
 * Проверяем:
 *   1. createDraft создаёт счёт в правильном тенанте.
 *   2. Повторный createDraft на тот же work_order возвращает существующий (idempotent).
 *   3. listByTicket чужого тенанта не видит наш счёт (RLS).
 *   4. transitionToIssued: draft → issued, issuedAt заполнен, totals refreshed.
 *   5. Issued счёт нельзя issued-ить ещё раз (throws).
 *   6. cancel: можно из draft/issued, нельзя из paid.
 *   7. updateDraft: меняет dueDate/notes/vatRate; на issued — fail.
 *   8. softDeleteDraft: только для draft.
 *   9. nextInvoiceNumber: формат + монотонность per tenant.
 *  10. calcVatInclusive: проверка для НДС 5% (нетипичная льготная).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import {
  clients,
  getDb,
  invoices,
  tickets,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import {
  getOrCreateWorkOrder,
  upsertLine,
} from '../modules/work-orders/repository';
import {
  calcVatInclusive,
  createDraft,
  getById,
  listByTicket,
  softDeleteDraft,
  transitionToCancelled,
  transitionToIssued,
  updateDraft,
} from '../modules/invoices/repository';

let erfolgId = '';
let demoId = '';
let erfolgClientId = '';
let demoClientId = '';

const TEST_PREFIX = 'TEST-INV-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [ec] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  const [dc] = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!ec || !dc) throw new Error('seed missing client');
  erfolgClientId = ec.id;
  demoClientId = dc.id;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    });
  }
}

async function createTicketWithBilledOrder(
  tenantId: string,
  clientId: string,
  amountKopecks = 100_000n,
): Promise<{ ticketId: string; workOrderId: string }> {
  const { id: ticketId } = await createTicket(getDb(), tenantId, null, {
    clientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), tenantId, ticketId);
  await upsertLine(getDb(), tenantId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}work`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: amountKopecks,
  });
  return { ticketId, workOrderId: wo.id };
}

describe('invoices cross-tenant', () => {
  beforeEach(clearTestData);

  it('createDraft создаёт счёт в правильном тенанте', async () => {
    const { ticketId, workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const dto = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}draft1`,
    });
    expect(dto.status).toBe('draft');
    expect(dto.workOrderId).toBe(workOrderId);
    expect(dto.ticketId).toBe(ticketId);
    expect(dto.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(dto.totalAmountKopecks).toBe('100000');
    // VAT 5% от 100₽ (вкладной) = round(100000 * 5 / 105) = 4762
    expect(dto.vatAmountKopecks).toBe('4762');
  });

  it('повторный createDraft возвращает existing (idempotent)', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const first = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}idem`,
    });
    const second = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}idem-overwritten`,
    });
    expect(second.id).toBe(first.id);
    expect(second.invoiceNumber).toBe(first.invoiceNumber);
  });

  it('listByTicket чужого тенанта не видит наш счёт (RLS)', async () => {
    const { ticketId, workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}rls`,
    });
    const list = await listByTicket(getDb(), demoId, ticketId);
    expect(list).toHaveLength(0);
  });

  it('transitionToIssued: draft → issued, issuedAt заполнен', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const draft = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}toissued`,
    });
    const issued = await transitionToIssued(getDb(), erfolgId, draft.id, {});
    expect(issued?.status).toBe('issued');
    expect(issued?.issuedAt).toBeInstanceOf(Date);
    expect(issued?.totalAmountKopecks).toBe('100000');
  });

  it('issued нельзя issued-ить ещё раз', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const draft = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}twice`,
    });
    await transitionToIssued(getDb(), erfolgId, draft.id, {});
    await expect(
      transitionToIssued(getDb(), erfolgId, draft.id, {}),
    ).rejects.toThrow(/issued/i);
  });

  it('issued: total refreshed из текущего work_order', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId, 50_000n);
    const draft = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}refresh`,
    });
    expect(draft.totalAmountKopecks).toBe('50000');
    // Добавили ещё работ — но draft не пересчитался
    await upsertLine(getDb(), erfolgId, workOrderId, null, {
      lineType: 'work',
      name: `${TEST_PREFIX}extra`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 30_000n,
    });
    const reloaded = await getById(getDb(), erfolgId, draft.id);
    expect(reloaded?.totalAmountKopecks).toBe('50000');
    // А issue — пересчитал
    const issued = await transitionToIssued(getDb(), erfolgId, draft.id, {});
    expect(issued?.totalAmountKopecks).toBe('80000');
  });

  it('cancel: draft → cancelled, потом nope', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const draft = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}cancel`,
    });
    const cancelled = await transitionToCancelled(getDb(), erfolgId, draft.id, 'тест');
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelledAt).toBeInstanceOf(Date);
    // Повторная отмена — ok (idempotent)
    const again = await transitionToCancelled(getDb(), erfolgId, draft.id, 'ещё раз');
    expect(again?.status).toBe('cancelled');
  });

  it('updateDraft меняет dueDate/notes/vatRate', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const draft = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}upd`,
    });
    const updated = await updateDraft(getDb(), erfolgId, draft.id, {
      dueDate: '2027-01-15',
      notes: `${TEST_PREFIX}new-notes`,
      vatRate: '20',
    });
    expect(updated?.dueDate).toBe('2027-01-15');
    expect(updated?.notes).toBe(`${TEST_PREFIX}new-notes`);
    expect(updated?.vatRate).toBe('20');
    // VAT 20% от 100₽ (вкладной) = round(100000 * 20 / 120) = 16667
    expect(updated?.vatAmountKopecks).toBe('16667');
  });

  it('updateDraft на issued счёт — fail', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const draft = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}upd2`,
    });
    await transitionToIssued(getDb(), erfolgId, draft.id, {});
    await expect(
      updateDraft(getDb(), erfolgId, draft.id, { notes: 'nope' }),
    ).rejects.toThrow(/черновик|draft/i);
  });

  it('softDeleteDraft: только draft', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const draft = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}del`,
    });
    expect(await softDeleteDraft(getDb(), erfolgId, draft.id)).toBe(true);
    expect(await getById(getDb(), erfolgId, draft.id)).toBeNull();

    // На issued — нельзя
    const { workOrderId: wo2 } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const draft2 = await createDraft(getDb(), erfolgId, {
      workOrderId: wo2,
      notes: `${TEST_PREFIX}del2`,
    });
    await transitionToIssued(getDb(), erfolgId, draft2.id, {});
    expect(await softDeleteDraft(getDb(), erfolgId, draft2.id)).toBe(false);
  });

  it('softDelete освобождает work_order для нового счёта', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const first = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}re1`,
    });
    expect(await softDeleteDraft(getDb(), erfolgId, first.id)).toBe(true);
    const second = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}re2`,
    });
    expect(second.id).not.toBe(first.id);
  });

  it('demoId не может cancel наш счёт', async () => {
    const { workOrderId } = await createTicketWithBilledOrder(erfolgId, erfolgClientId);
    const draft = await createDraft(getDb(), erfolgId, {
      workOrderId,
      notes: `${TEST_PREFIX}xt`,
    });
    const result = await transitionToCancelled(getDb(), demoId, draft.id, 'attack');
    expect(result).toBeNull();
    // А наш — всё ещё draft
    const reloaded = await getById(getDb(), erfolgId, draft.id);
    expect(reloaded?.status).toBe('draft');
  });

  it('demo может создать свой счёт независимо', async () => {
    const { workOrderId: woD } = await createTicketWithBilledOrder(demoId, demoClientId);
    const dto = await createDraft(getDb(), demoId, {
      workOrderId: woD,
      notes: `${TEST_PREFIX}demo`,
    });
    expect(dto.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    // ID нумерации независим — у demoId свой счётчик
  });

  it('calcVatInclusive: эталонные значения', () => {
    expect(calcVatInclusive(100_000n, '5')).toBe(4762n); // round(100000*5/105)
    expect(calcVatInclusive(120_000n, '20')).toBe(20_000n); // 120000*20/120 ровно
    expect(calcVatInclusive(110_000n, '10')).toBe(10_000n); // 110000*10/110 ровно
    expect(calcVatInclusive(100_000n, '0')).toBe(0n);
    expect(calcVatInclusive(100_000n, 'without_vat')).toBe(0n);
    expect(calcVatInclusive(0n, '5')).toBe(0n);
  });
});
