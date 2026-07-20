/**
 * Регресс на самую опасную мину модуля 1С.
 *
 * Отметка «выгружено в 1С» НЕОБРАТИМА: снять её нечем — ни кнопки в интерфейсе,
 * ни процедуры в API, ни скрипта во всём проекте. Помеченный счёт больше никогда
 * не попадёт в выгрузку.
 *
 * Раньше markOnecSynced стоял ВНУТРИ цикла по счетам, то есть отметка ставилась
 * ДО сборки XML. Если сборка падала, счета уже были помечены — файла нет, счета
 * из очереди выпали навсегда. Теперь пометка идёт после успешной сборки и одним
 * запросом: либо помечены все попавшие в файл, либо ни один.
 *
 * Отдельный файл, потому что здесь подменяется сборщик XML — в основном
 * onec-exchange.test.ts проверяется как раз настоящий сборщик.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  clients,
  getDb,
  invoices,
  onecConfigs,
  onecExchangeLog,
  tickets,
  withTenantTx,
} from '@erfolg/db';

import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import {
  createDraft,
  listPendingOnecExport,
  transitionToIssued,
} from '../modules/invoices/repository';
import { exportInvoicesToOnecCmd } from '../modules/onec';
import { upsertConfig } from '../modules/onec/repository';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';
import type * as OnecXml from '../lib/onec-xml';

// vi.mock поднимается выше импортов, поэтому service получит уже подменённый
// сборщик, хотя импорты записаны обычным образом.
vi.mock('../lib/onec-xml', async (importOriginal) => {
  const actual = await importOriginal<typeof OnecXml>();
  return {
    ...actual,
    buildCommerceMlExport: () => {
      throw new Error('сборка XML упала (тест)');
    },
  };
});

const TEST_PREFIX = 'TEST8FATOM-';

let erfolgId = '';
let primaryClientId = '';
let tenantCtx: ResolvedTenant;
let sessionCtx: SessionData;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
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

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(onecExchangeLog).where(eq(onecExchangeLog.tenantId, erfolgId));
    await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}

beforeEach(async () => {
  await clearTestData();
  await upsertConfig(getDb(), erfolgId, { enabled: true });
});

afterAll(async () => {
  await clearTestData();
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(onecConfigs).where(eq(onecConfigs.tenantId, erfolgId));
  });
});

async function setupIssuedInvoice(): Promise<string> {
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
  return issued.id;
}

describe('экспорт в 1С: сборка файла упала', () => {
  it('ни один счёт не помечен выгруженным', async () => {
    const a = await setupIssuedInvoice();
    const b = await setupIssuedInvoice();

    await expect(
      exportInvoicesToOnecCmd({
        db: getDb(),
        tenant: tenantCtx,
        session: sessionCtx,
        audit: { ip: '127.0.0.1', userAgent: 'test' },
      }),
    ).rejects.toThrow(/сборка XML упала/);

    for (const id of [a, b]) {
      const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
        tx
          .select({ syncedAt: invoices.onecSyncedAt, externalId: invoices.onecExternalId })
          .from(invoices)
          .where(eq(invoices.id, id)),
      );
      expect(row?.syncedAt).toBeNull();
      expect(row?.externalId).toBeNull();
    }
  });

  it('счета остаются в очереди — их видно как ожидающих выгрузки', async () => {
    const id = await setupIssuedInvoice();

    await expect(
      exportInvoicesToOnecCmd({
        db: getDb(),
        tenant: tenantCtx,
        session: sessionCtx,
        audit: { ip: '127.0.0.1', userAgent: 'test' },
      }),
    ).rejects.toThrow();

    const pending = await listPendingOnecExport(getDb(), erfolgId, 500);
    expect(pending.some((inv) => inv.id === id)).toBe(true);
  });
});
