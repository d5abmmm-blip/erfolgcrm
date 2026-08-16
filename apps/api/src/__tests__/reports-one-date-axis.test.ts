/**
 * На экране «Отчёты» одна кнопка периода — значит и ось дат одна.
 *
 * ЧТО БЫЛО. «Выручка по клиентам», «Загрузка инженеров» и «Соблюдение SLA»
 * считались по дате ЗАВЕДЕНИЯ заявки, а «Рентабельность» — по дате закрытия. За
 * один и тот же квартал три вкладки давали три разных числа, и сложить их между
 * собой было нельзя.
 *
 * Ось выбрана одна — ДАТА ЗАКРЫТИЯ: так считает рентабельность, ведомость ЗП и
 * «Загрузка инженеров» на карточке сотрудника, и так решил владелец 2026-08-15
 * (работа засчитывается по дате, когда её сделали).
 *
 * Заявка ниже заведена в одном месяце, а закрыта в другом — она и разводит две оси.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  engineerPerformance,
  revenueByClient,
  profitabilityReport,
} from '../modules/reports/repository';

const PREFIX = 'TEST-REPAXIS-';
/** Заведена в марте 2033-го, закрыта в апреле. Год пустой — соседи туда не пишут. */
const CREATED = '2033-03-10T09:00:00Z';
const CLOSED = '2033-04-12T15:00:00Z';
const MARCH = { from: '2033-03-01', to: '2033-03-31' };
const APRIL = { from: '2033-04-01', to: '2033-04-30' };

let erfolgId = '';
let clientId = '';
let engineerId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  const [e] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'engineer')).limit(1),
  );
  if (!c || !e) throw new Error('seed missing client/engineer');
  clientId = c.id;
  engineerId = e.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(tickets).where(like(tickets.symptom, `${PREFIX}%`)),
  );
});

/** Заявка с нарядом: рентабельность считает по нарядам, без него её не видно. */
async function ticketCreatedInMarchClosedInApril(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO tickets
        (tenant_id, ticket_number, barcode, client_id, assigned_engineer_id, status,
         symptom, received_at, created_at, closed_at)
      VALUES (${erfolgId}::uuid, ${'T-' + PREFIX}, ${'BC-' + PREFIX}, ${clientId}::uuid,
              ${engineerId}::uuid, 'closed', ${PREFIX + 'через месяц'},
              ${CREATED}::timestamptz, ${CREATED}::timestamptz, ${CLOSED}::timestamptz)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const ticketId = rows[0]!.id;
    await tx.execute(sql`
      INSERT INTO work_orders
        (tenant_id, ticket_id, order_number, engineer_id, total_amount_kopecks,
         cost_amount_kopecks, margin_amount_kopecks)
      VALUES (${erfolgId}::uuid, ${ticketId}::uuid, ${'WO-' + PREFIX}, ${engineerId}::uuid,
              100000, 30000, 70000)
    `);
  });
}

async function engineerTickets(period: { from: string; to: string }): Promise<number> {
  const rows = await engineerPerformance(getDb(), erfolgId, period);
  return rows.find((r) => r.engineerId === engineerId)?.ticketsCount ?? 0;
}

async function clientTickets(period: { from: string; to: string }): Promise<number> {
  const rows = await revenueByClient(getDb(), erfolgId, period);
  return rows.find((r) => r.clientId === clientId)?.ticketsCount ?? 0;
}

async function profitOrders(period: { from: string; to: string }): Promise<number> {
  return (await profitabilityReport(getDb(), erfolgId, period)).summary.closedOrdersCount;
}

describe('период в отчётах — по дате закрытия', () => {
  it('«Загрузка инженеров» считает заявку в месяце закрытия, а не заведения', async () => {
    const engBeforeApril = await engineerTickets(APRIL);
    const engBeforeMarch = await engineerTickets(MARCH);
    await ticketCreatedInMarchClosedInApril();

    expect(await engineerTickets(APRIL)).toBe(engBeforeApril + 1);
    expect(await engineerTickets(MARCH)).toBe(engBeforeMarch);
  });

  it('«Выручка по клиентам» считает её там же', async () => {
    const cliBeforeApril = await clientTickets(APRIL);
    const cliBeforeMarch = await clientTickets(MARCH);
    await ticketCreatedInMarchClosedInApril();

    expect(await clientTickets(APRIL)).toBe(cliBeforeApril + 1);
    expect(await clientTickets(MARCH)).toBe(cliBeforeMarch);
  });

  it('«Рентабельность» и «Загрузка инженеров» видят один и тот же месяц', async () => {
    const profBefore = await profitOrders(APRIL);
    const engBefore = await engineerTickets(APRIL);
    await ticketCreatedInMarchClosedInApril();

    // Обе вкладки прибавили по одной заявке — раньше «Загрузка» прибавляла её в марте.
    expect(await profitOrders(APRIL)).toBe(profBefore + 1);
    expect(await engineerTickets(APRIL)).toBe(engBefore + 1);
  });
});
