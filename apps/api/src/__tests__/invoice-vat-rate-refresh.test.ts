/**
 * Выставление счёта берёт из наряда ОБЕ величины снимка: сумму И ставку НДС.
 *
 * ЧТО БЫЛО. transitionToIssued освежал сумму из наряда, а НДС считал по ставке,
 * запомненной в черновике при его создании. Менеджер создал черновик, потом
 * поправил ставку наряда (у медтехники льготные 5 %, у прочего 20 %) — счёт
 * выставлялся со старой ставкой: сумма новая, НДС от неё — по забытой ставке.
 * Расхождение уходило клиенту в печатный счёт.
 *
 * Ставка на счёте НИГДЕ не правится руками (интерфейс шлёт в updateDraft только
 * заметки) — её единственный источник это наряд, как и у суммы. Значит на
 * выставлении снимок должен обновляться целиком.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, invoices, tickets, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import {
  getOrCreateWorkOrder,
  updateWorkOrderHeader,
  upsertLine,
} from '../modules/work-orders/repository';
import {
  calcVatInclusive,
  createDraft,
  transitionToIssued,
} from '../modules/invoices/repository';

let erfolgId = '';
let clientId = '';

const TEST_PREFIX = 'TESTVATREFRESH-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

async function setupDraft(): Promise<{ workOrderId: string; invoiceId: string }> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}work`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: 100_000n,
  });
  const draft = await createDraft(getDb(), erfolgId, {
    workOrderId: wo.id,
    notes: `${TEST_PREFIX}invoice`,
  });
  return { workOrderId: wo.id, invoiceId: draft.id };
}

describe('ставка НДС при выставлении счёта', () => {
  it('ставку наряда, изменённую после черновика, счёт подхватывает', async () => {
    const { workOrderId, invoiceId } = await setupDraft();
    // Черновик снял ставку по умолчанию (5 %). Менеджер меняет ставку наряда.
    await updateWorkOrderHeader(getDb(), erfolgId, workOrderId, { vatRate: '20' });

    const issued = await transitionToIssued(getDb(), erfolgId, invoiceId, {});

    expect(issued?.vatRate).toBe('20');
    // И сумма НДС посчитана по НОВОЙ ставке, а не по забытой из черновика.
    expect(issued?.vatAmountKopecks).toBe(calcVatInclusive(100_000n, '20').toString());
  });

  it('«Без НДС» на наряде обнуляет НДС в счёте', async () => {
    const { workOrderId, invoiceId } = await setupDraft();
    await updateWorkOrderHeader(getDb(), erfolgId, workOrderId, { vatRate: 'without_vat' });

    const issued = await transitionToIssued(getDb(), erfolgId, invoiceId, {});

    expect(issued?.vatRate).toBe('without_vat');
    expect(issued?.vatAmountKopecks).toBe('0');
  });

  it('ставка не менялась — счёт выставляется как раньше', async () => {
    const { invoiceId } = await setupDraft();

    const issued = await transitionToIssued(getDb(), erfolgId, invoiceId, {});

    expect(issued?.vatRate).toBe('5');
    expect(issued?.vatAmountKopecks).toBe(calcVatInclusive(100_000n, '5').toString());
  });
});
