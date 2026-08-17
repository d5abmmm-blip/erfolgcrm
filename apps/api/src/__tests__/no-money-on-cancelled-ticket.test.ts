/**
 * По отменённой заявке денег не бывает.
 *
 * ЧТО БЫЛО. Статус заявки не проверялся нигде на денежном пути: счёт по отменённой
 * заявке выставлялся, платёж по ней принимался (сверялась только принадлежность
 * тенанту). На карточке кнопка «Выставить счёт» показывалась при любом статусе.
 *
 * Отмена — это «работы не будет». Счёт по такой заявке уходит клиенту как
 * действующий, а принятый платёж встаёт в кассу и в дебиторку и потом ищется руками.
 *
 * Отменённый СЧЁТ уже был закрыт от оплаты (addPayment проверял его статус) — здесь
 * закрывается сама заявка, то есть шаг раньше.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like, sql } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket, changeStatus } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const PREFIX = 'TEST-NOMONEY-';

let erfolgId = '';
let clientId = '';
let directorId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  const [u] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).limit(1),
  );
  if (!c || !u) throw new Error('seed missing client/user');
  clientId = c.id;
  directorId = u.id;
});

/**
 * Порядок чистки важен: с миграции 0085 payments держит заявку по RESTRICT, а счёт
 * держит наряд. Удалять начинаем с денег, иначе DELETE падает на чужих ссылках.
 */
beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    const mine = sql`SELECT id FROM tickets WHERE symptom LIKE ${PREFIX + '%'}`;
    await tx.execute(sql`DELETE FROM payments WHERE ticket_id IN (${mine})`);
    await tx.execute(sql`DELETE FROM invoices WHERE ticket_id IN (${mine})`);
    await tx.execute(sql`
      DELETE FROM work_order_lines WHERE work_order_id IN (
        SELECT id FROM work_orders WHERE ticket_id IN (${mine})
      )
    `);
    await tx.execute(sql`DELETE FROM work_orders WHERE ticket_id IN (${mine})`);
    await tx.delete(tickets).where(like(tickets.symptom, `${PREFIX}%`));
  });
});

function ctx(): Context {
  const session: SessionData = {
    tenantId: erfolgId,
    userId: directorId,
    username: 'director-nomoney',
    role: 'director',
    fullName: 'Тест Директор',
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: erfolgId,
      subdomain: 'erfolg',
      displayName: 'erfolg',
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    },
    session,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } } as any,
    ip: null,
    userAgent: null,
  } as unknown as Context;
}

/** Заявка с нарядом на 5 000 ₽. */
async function ticketWithMoney(): Promise<{ ticketId: string; workOrderId: string }> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${PREFIX}заявка`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'work',
    name: `${PREFIX}работа`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: 500_000n,
  });
  return { ticketId, workOrderId: wo.id };
}

describe('отменённая заявка не пускает деньги', () => {
  it('счёт по отменённой заявке не выставляется', async () => {
    const { ticketId, workOrderId } = await ticketWithMoney();
    await changeStatus(getDb(), erfolgId, null, ticketId, 'cancelled', 'клиент отказался');

    await expect(
      appRouter.createCaller(ctx()).invoices.createDraft({ workOrderId }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('платёж по отменённой заявке не принимается', async () => {
    const { ticketId } = await ticketWithMoney();
    await changeStatus(getDb(), erfolgId, null, ticketId, 'cancelled', 'клиент отказался');

    await expect(
      appRouter.createCaller(ctx()).payments.add({
        ticketId,
        amountRub: 5000,
        method: 'cash',
        paidAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('по обычной заявке и счёт, и платёж проходят как раньше', async () => {
    const { ticketId, workOrderId } = await ticketWithMoney();
    const caller = appRouter.createCaller(ctx());

    const invoice = await caller.invoices.createDraft({ workOrderId });
    expect(invoice.id).toBeTruthy();

    const paid = await caller.payments.add({
      ticketId,
      amountRub: 1000,
      method: 'cash',
      paidAt: new Date(),
    });
    expect(paid.id).toBeTruthy();
  });
});
