/**
 * Этап 8.F — обмен с 1С:
 *   • XML-генерация валидна (включает реквизиты + товары + НДС).
 *   • exportInvoicesToOnec помечает invoices как onec_synced.
 *   • receivePaymentsFromOnec корректно создаёт payments по invoice ID + по invoiceNumber.
 *   • Не платит draft/cancelled.
 *   • Token verify constant-time.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  invoices,
  onecConfigs,
  onecExchangeLog,
  payments,
  tickets,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import {
  createDraft,
  transitionToCancelled,
  transitionToIssued,
} from '../modules/invoices/repository';
import {
  exportInvoicesToOnecCmd,
  generateIncomingToken,
  hashIncomingToken,
  receivePaymentsFromOnecCmd,
  verifyIncomingToken,
} from '../modules/onec';
import { setIncomingTokenHash, upsertConfig } from '../modules/onec/repository';
import { buildCommerceMlExport, parseIncomingPayments } from '../lib/onec-xml';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let primaryClientId = '';
let demoId = '';
let tenantCtx: ResolvedTenant;
let sessionCtx: SessionData;

const TEST_PREFIX = 'TEST8F-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
  tenantCtx = {
    id: erfolgId,
    subdomain: 'erfolg',
    displayName: 'ООО Эрфольг',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
  sessionCtx = {
    userId: null,
    tenantId: erfolgId,
    role: 'director',
    username: 'director',
    expiresAt: new Date(Date.now() + 3600_000),
  } as unknown as SessionData;
});

afterAll(async () => {
  // Чистим конфиг 1С (мог быть тоggle'нут)
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(onecConfigs).where(eq(onecConfigs.tenantId, erfolgId));
  });
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(onecExchangeLog).where(eq(onecExchangeLog.tenantId, tid));
      await tx.delete(payments).where(like(payments.comment, `${TEST_PREFIX}%`));
      await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    });
  }
}

async function setupIssuedInvoice(): Promise<{
  ticketId: string;
  invoiceId: string;
  invoiceNumber: string;
}> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}work`,
    unit: 'час',
    quantity: '1',
    unitPriceKopecks: 100_000n,
  });
  const draft = await createDraft(getDb(), erfolgId, {
    workOrderId: wo.id,
    notes: `${TEST_PREFIX}inv`,
  });
  const issued = await transitionToIssued(getDb(), erfolgId, draft.id, {});
  if (!issued) throw new Error('issue failed');
  return { ticketId, invoiceId: issued.id, invoiceNumber: issued.invoiceNumber };
}

describe('onec-xml lib', () => {
  it('buildCommerceMlExport — root element + namespaces + escape', () => {
    const xml = buildCommerceMlExport({
      packageId: 'pkg-1',
      generatedAt: '2026-04-30T10:00:00Z',
      documents: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          number: 'INV-2026-000001',
          date: '2026-04-30',
          totalAmount: 1000,
          vatAmount: 47.62,
          vatRate: '5',
          supplier: { id: 'sup-1', name: 'ООО «Эрфольг» <test>', inn: '7700000001' },
          buyer: { id: 'buy-1', name: 'ГБУ Тест', inn: '7700000002', kpp: '770001001' },
          lines: [
            {
              id: 'line-1',
              name: 'Диагностика & ремонт',
              unit: 'час',
              quantity: '1',
              pricePerUnit: 1000,
              totalAmount: 1000,
              vatRate: '5',
              vatAmount: 47.62,
            },
          ],
        },
      ],
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<КоммерческаяИнформация');
    expect(xml).toContain('INV-2026-000001');
    expect(xml).toContain('ООО «Эрфольг» &lt;test&gt;'); // escape
    expect(xml).toContain('Диагностика &amp; ремонт');
    expect(xml).toContain('1000.00');
    expect(xml).toContain('5%');
  });

  it('parseIncomingPayments — валидация структуры', () => {
    const ok = parseIncomingPayments({
      payments: [
        {
          invoiceExternalId: '11111111-1111-1111-1111-111111111111',
          amountKopecks: '100000',
          paidAt: '2026-04-30',
          method: 'bank_transfer',
        },
      ],
    });
    expect(ok).toHaveLength(1);
    expect(ok[0]?.method).toBe('bank_transfer');

    expect(() => parseIncomingPayments({})).toThrow(/payments/);
    expect(() =>
      parseIncomingPayments({
        payments: [{ amountKopecks: '0', paidAt: '2026-04-30', method: 'cash' }],
      }),
    ).toThrow(/invoiceExternalId|invoiceNumber/i);
  });
});

describe('onec service (8.F)', () => {
  beforeEach(async () => {
    await clearTestData();
    // Выгрузка требует включённого обмена. Раньше конфига не было вовсе и
    // экспорт работал при выключенном тумблере — это и чиним.
    await upsertConfig(getDb(), erfolgId, { enabled: true });
  });

  it('hashIncomingToken stable + verifyIncomingToken constant-time', () => {
    const t = generateIncomingToken();
    expect(t.token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash).toBe(hashIncomingToken(t.token));
    expect(verifyIncomingToken(t.token, t.hash)).toBe(true);
    expect(verifyIncomingToken('wrong', t.hash)).toBe(false);
  });

  it('exportInvoicesToOnec помечает invoice как synced', async () => {
    const { invoiceId } = await setupIssuedInvoice();
    const result = await exportInvoicesToOnecCmd({
      db: getDb(),
      tenant: tenantCtx,
      session: sessionCtx,
      audit: { ip: '127.0.0.1', userAgent: 'test' },
    });
    expect(result.processedCount).toBeGreaterThanOrEqual(1);
    expect(result.errorCount).toBe(0);
    expect(result.xml).toContain('КоммерческаяИнформация');

    // invoice должен быть помечен
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ syncedAt: invoices.onecSyncedAt, externalId: invoices.onecExternalId })
        .from(invoices)
        .where(eq(invoices.id, invoiceId)),
    );
    expect(row?.syncedAt).toBeInstanceOf(Date);
    expect(row?.externalId).toBeTruthy();
  });

  it('повторный export не выгружает наш invoice второй раз', async () => {
    const { invoiceId } = await setupIssuedInvoice();
    await exportInvoicesToOnecCmd({
      db: getDb(),
      tenant: tenantCtx,
      session: sessionCtx,
      audit: { ip: '127.0.0.1', userAgent: 'test' },
    });
    const [afterFirst] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ syncedAt: invoices.onecSyncedAt })
        .from(invoices)
        .where(eq(invoices.id, invoiceId)),
    );
    expect(afterFirst?.syncedAt).toBeInstanceOf(Date);
    const firstStamp = afterFirst?.syncedAt?.getTime();

    const second = await exportInvoicesToOnecCmd({
      db: getDb(),
      tenant: tenantCtx,
      session: sessionCtx,
      audit: { ip: '127.0.0.1', userAgent: 'test' },
    });
    // Наш invoice не должен попасть во второй export.
    const secondXmlContainsOurInvoice = second.xml.includes(invoiceId);
    expect(secondXmlContainsOurInvoice).toBe(false);
    // syncedAt не двигается.
    const [afterSecond] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ syncedAt: invoices.onecSyncedAt })
        .from(invoices)
        .where(eq(invoices.id, invoiceId)),
    );
    expect(afterSecond?.syncedAt?.getTime()).toBe(firstStamp);
  });

  it('при ВЫКЛЮЧЕННОМ обмене экспорт запрещён и ничего не помечает', async () => {
    const { invoiceId } = await setupIssuedInvoice();
    await upsertConfig(getDb(), erfolgId, { enabled: false });

    await expect(
      exportInvoicesToOnecCmd({
        db: getDb(),
        tenant: tenantCtx,
        session: sessionCtx,
        audit: { ip: '127.0.0.1', userAgent: 'test' },
      }),
    ).rejects.toThrow(/Обмен с 1С выключен/);

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ syncedAt: invoices.onecSyncedAt })
        .from(invoices)
        .where(eq(invoices.id, invoiceId)),
    );
    expect(row?.syncedAt).toBeNull();

    // Выключенный обмен не должен оставлять следов в журнале.
    const log = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ id: onecExchangeLog.id }).from(onecExchangeLog),
    );
    expect(log).toHaveLength(0);
  });

  it('обмен включён БЕЗ входящего токена — экспорт работает', async () => {
    // Входящий токен нужен вебхуку приёма платежей, к выгрузке файла он
    // отношения не имеет. Страж, требующий токен, ломал бы экспорт на ровном
    // месте — в том числе после кнопки «Отозвать токен».
    await setIncomingTokenHash(getDb(), erfolgId, null);
    await upsertConfig(getDb(), erfolgId, { enabled: true });
    await setupIssuedInvoice();

    const result = await exportInvoicesToOnecCmd({
      db: getDb(),
      tenant: tenantCtx,
      session: sessionCtx,
      audit: { ip: '127.0.0.1', userAgent: 'test' },
    });
    expect(result.processedCount).toBeGreaterThanOrEqual(1);
  });

  it('помечены ровно те счета, что попали в файл', async () => {
    const a = await setupIssuedInvoice();
    const b = await setupIssuedInvoice();

    const result = await exportInvoicesToOnecCmd({
      db: getDb(),
      tenant: tenantCtx,
      session: sessionCtx,
      audit: { ip: '127.0.0.1', userAgent: 'test' },
    });

    for (const id of [a.invoiceId, b.invoiceId]) {
      expect(result.xml).toContain(id);
      const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
        tx.select({ syncedAt: invoices.onecSyncedAt }).from(invoices).where(eq(invoices.id, id)),
      );
      expect(row?.syncedAt).toBeInstanceOf(Date);
    }
    expect(result.errorCount).toBe(0);
  });

  it('отменённый счёт в 1С не выгружается', async () => {
    const { invoiceId } = await setupIssuedInvoice();
    const cancelled = await transitionToCancelled(
      getDb(),
      erfolgId,
      invoiceId,
      `${TEST_PREFIX}отмена`,
    );
    expect(cancelled).toBeTruthy();

    const result = await exportInvoicesToOnecCmd({
      db: getDb(),
      tenant: tenantCtx,
      session: sessionCtx,
      audit: { ip: '127.0.0.1', userAgent: 'test' },
    });

    expect(result.xml).not.toContain(invoiceId);
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ syncedAt: invoices.onecSyncedAt })
        .from(invoices)
        .where(eq(invoices.id, invoiceId)),
    );
    expect(row?.syncedAt).toBeNull();
  });

  it('отчёт говорит, сколько ждало всего и сколько осталось', async () => {
    await setupIssuedInvoice();
    await setupIssuedInvoice();

    const result = await exportInvoicesToOnecCmd({
      db: getDb(),
      tenant: tenantCtx,
      session: sessionCtx,
      audit: { ip: '127.0.0.1', userAgent: 'test' },
    });

    expect(result.totalPending).toBeGreaterThanOrEqual(2);
    expect(result.processedCount).toBe(result.totalPending);
    expect(result.remaining).toBe(0);
  });

  it('receivePaymentsFromOnec — payment по invoiceExternalId', async () => {
    const { ticketId, invoiceId } = await setupIssuedInvoice();
    const result = await receivePaymentsFromOnecCmd(getDb(), tenantCtx, {
      body: {
        payments: [
          {
            invoiceExternalId: invoiceId,
            amountKopecks: '100000',
            paidAt: new Date().toISOString(),
            method: 'bank_transfer',
            comment: `${TEST_PREFIX}received-uuid`,
          },
        ],
      },
    });
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const [inv] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ status: invoices.status, paid: invoices.paidAmountKopecks })
        .from(invoices)
        .where(eq(invoices.id, invoiceId)),
    );
    expect(inv?.status).toBe('paid');
    expect(inv?.paid).toBe(100_000n);
    void ticketId;
  });

  it('receivePaymentsFromOnec — payment по invoiceNumber (без UUID)', async () => {
    const { invoiceId, invoiceNumber } = await setupIssuedInvoice();
    const result = await receivePaymentsFromOnecCmd(getDb(), tenantCtx, {
      body: {
        payments: [
          {
            invoiceNumber,
            amountKopecks: 50_000,
            paidAt: new Date().toISOString(),
            method: 'bank_transfer',
            comment: `${TEST_PREFIX}received-num`,
          },
        ],
      },
    });
    expect(result.processed).toBe(1);
    const [inv] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ status: invoices.status, paid: invoices.paidAmountKopecks })
        .from(invoices)
        .where(eq(invoices.id, invoiceId)),
    );
    expect(inv?.status).toBe('partially_paid');
    expect(inv?.paid).toBe(50_000n);
  });

  it('receivePayments не платит cancelled invoice', async () => {
    const { invoiceId } = await setupIssuedInvoice();
    await transitionToCancelled(getDb(), erfolgId, invoiceId, 'тест');
    const result = await receivePaymentsFromOnecCmd(getDb(), tenantCtx, {
      body: {
        payments: [
          {
            invoiceExternalId: invoiceId,
            amountKopecks: '10000',
            paidAt: new Date().toISOString(),
            method: 'cash',
            comment: `${TEST_PREFIX}cancelled-attempt`,
          },
        ],
      },
    });
    expect(result.processed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/cancelled/i);
  });

  it('receivePayments возвращает error для несуществующего invoice', async () => {
    const result = await receivePaymentsFromOnecCmd(getDb(), tenantCtx, {
      body: {
        payments: [
          {
            invoiceExternalId: '99999999-9999-9999-9999-999999999999',
            amountKopecks: '1000',
            paidAt: new Date().toISOString(),
            method: 'cash',
            comment: `${TEST_PREFIX}missing`,
          },
        ],
      },
    });
    expect(result.processed).toBe(0);
    expect(result.errors[0]?.message).toMatch(/not found/i);
  });
});
