/**
 * Удаление заявки (мягкое, deleted_at) — фича «кнопка Удалить».
 *
 * Покрытие:
 *   1. Директор удаляет «чистую» заявку → status='deleted', и она исчезает из списка,
 *      карточки (getTicket → undefined) и поиска.
 *   2. Повторное удаление / несуществующий id → status='not_found'.
 *   3. Защита: заявка с оплатой не удаляется (status='blocked', blockers.payments>0),
 *      остаётся видимой.
 *   4. Защита: заявка с выставленным счётом не удаляется (blockers.issuedInvoices>0).
 *   5. deleteTicketCmd бросает NOT_FOUND (нет заявки) и BAD_REQUEST (есть деньги).
 *
 * Изоляция под параллельный прогон тест-файлов: свои заявки по префиксу symptom,
 * чистка в beforeEach. Клиента берём из seed (как parts-waiting.test).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, invoices, payments, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createTicket,
  getTicket,
  listTickets,
  searchTickets,
  softDeleteTicket,
} from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { createDraft, transitionToIssued } from '../modules/invoices/repository';
import { deleteTicketCmd } from '../modules/tickets/service';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let clientId = '';
let directorId = '';

const TEST_PREFIX = 'TESTDEL-';
const PRICE = 100_000n;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  directorId = usrs.find((u) => u.role === 'director')?.id ?? usrs[0]!.id;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(payments).where(like(payments.comment, `${TEST_PREFIX}%`));
    await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}
beforeEach(clearTestData);

async function makeTicket(): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  return id;
}

async function addPaymentRow(ticketId: string): Promise<void> {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.insert(payments).values({
      tenantId: erfolgId,
      ticketId,
      amountKopecks: 5_000n,
      method: 'cash',
      comment: `${TEST_PREFIX}pay`,
    }),
  );
}

/** Создаёт выставленный (issued) счёт по заявке — блокирует удаление. */
async function issueInvoice(ticketId: string): Promise<void> {
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}work`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: PRICE,
  });
  const draft = await createDraft(getDb(), erfolgId, {
    workOrderId: wo.id,
    notes: `${TEST_PREFIX}inv`,
  });
  const issued = await transitionToIssued(getDb(), erfolgId, draft.id, {});
  if (!issued) throw new Error('issue failed');
}

function makeDirectorCtx() {
  const tenant: ResolvedTenant = {
    id: erfolgId,
    subdomain: 'test',
    displayName: 'test',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
  const session: SessionData = {
    tenantId: erfolgId,
    userId: directorId,
    username: 'director',
    role: 'director',
    fullName: 'Director',
    expiresAt: Date.now() + 60_000,
  };
  return { db: getDb(), tenant, session, audit: { ip: null, userAgent: null } };
}

describe('softDeleteTicket', () => {
  it('удаляет чистую заявку → исчезает из списка, карточки и поиска', async () => {
    const id = await makeTicket();

    const res = await softDeleteTicket(getDb(), erfolgId, id);
    expect(res.status).toBe('deleted');

    // Карточка: getTicket больше не находит.
    const card = await getTicket(getDb(), erfolgId, id);
    expect(card).toBeFalsy();

    // Список: заявки нет среди items.
    const list = await listTickets(getDb(), erfolgId, { pageSize: 200 });
    expect(list.items.some((t) => t.id === id)).toBe(false);

    // Поиск по симптому: удалённой заявки нет.
    const hits = await searchTickets(getDb(), erfolgId, `${TEST_PREFIX}flow`);
    expect(hits.some((h) => h.id === id)).toBe(false);
  });

  it('повторное удаление и несуществующий id → not_found', async () => {
    const id = await makeTicket();
    expect((await softDeleteTicket(getDb(), erfolgId, id)).status).toBe('deleted');
    expect((await softDeleteTicket(getDb(), erfolgId, id)).status).toBe('not_found');

    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await softDeleteTicket(getDb(), erfolgId, missing)).status).toBe('not_found');
  });

  it('заявку с оплатой удалить нельзя (blocked), она остаётся видимой', async () => {
    const id = await makeTicket();
    await addPaymentRow(id);

    const res = await softDeleteTicket(getDb(), erfolgId, id);
    expect(res.status).toBe('blocked');
    if (res.status === 'blocked') {
      expect(res.blockers.payments).toBeGreaterThan(0);
    }
    // Всё ещё открывается.
    expect(await getTicket(getDb(), erfolgId, id)).toBeTruthy();
  });

  it('заявку с выставленным счётом удалить нельзя (blocked)', async () => {
    const id = await makeTicket();
    await issueInvoice(id);

    const res = await softDeleteTicket(getDb(), erfolgId, id);
    expect(res.status).toBe('blocked');
    if (res.status === 'blocked') {
      expect(res.blockers.issuedInvoices).toBeGreaterThan(0);
    }
  });
});

describe('deleteTicketCmd', () => {
  it('NOT_FOUND для несуществующей заявки', async () => {
    const ctx = makeDirectorCtx();
    await expect(
      deleteTicketCmd(ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('BAD_REQUEST если у заявки есть деньги', async () => {
    const id = await makeTicket();
    await addPaymentRow(id);
    const ctx = makeDirectorCtx();
    await expect(deleteTicketCmd(ctx, id)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('успешно удаляет чистую заявку', async () => {
    const id = await makeTicket();
    const ctx = makeDirectorCtx();
    const res = await deleteTicketCmd(ctx, id);
    expect(res.id).toBe(id);
    expect(await getTicket(getDb(), erfolgId, id)).toBeFalsy();
  });
});
