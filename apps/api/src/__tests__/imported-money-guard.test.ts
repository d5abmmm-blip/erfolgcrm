/**
 * Деньги старой системы: две защиты, которых не хватало.
 *
 * 1. ЗАРПЛАТА. Строки работ из старой программы полностью подходят под расчёт: у них
 *    есть и исполнитель, и цена. Не пускает их СЛУЧАЙНОСТЬ — импорт завёл перенесённых
 *    сотрудников неактивными, а ведомость считает только по активным. Достаточно
 *    разблокировать такую учётку (одна кнопка в настройках) — и тысячи строк за
 *    2015-2026 годы станут начисляемыми. На бою строк работ с уволенным инженером 2218.
 *    Работа за них давно оплачена в старой программе; платить второй раз нельзя.
 *
 * 2. ОПЛАТА НАРЯДА. Импорт кладёт в шапку наряда сумму, оплаченную в прежней
 *    программе, но строк платежей не создаёт. Пересчёт оплаты безусловно перезаписывал
 *    шапку суммой платежей CRM — то есть ПЕРВЫЙ же платёж по старой заявке стирал
 *    историческую оплату. Ту же беду с себестоимостью в этом проекте уже лечили
 *    (resolveHeaderCost), здесь защиты не было.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx, workOrders } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket, changeStatus } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import { computePayouts } from '../modules/payroll/repository';
import { addPayment, deletePayment, listByTicket } from '../modules/payments/repository';

const PREFIX = 'TEST-IMPMONEY-';

/**
 * Считаем в заведомо «мёртвом» месяце марта 2019: соседний файл про ведомость ЗП
 * работает по текущим датам и в том же тенанте, а vitest гоняет файлы параллельно —
 * на общем периоде тесты видели чужие строки работ.
 */

/** Идентификатор версии 5 — так выглядит запись, перенесённая импортом. */
const LEGACY_LINE_ID = '3f2504e0-4f89-51d3-9a0c-0305e82c33f1';

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
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.execute(sql`
      DELETE FROM payments WHERE ticket_id IN (
        SELECT id FROM tickets WHERE symptom LIKE ${PREFIX + '%'}
      )
    `);
    await tx.execute(sql`
      DELETE FROM work_order_lines WHERE work_order_id IN (
        SELECT wo.id FROM work_orders wo
          JOIN tickets t ON t.id = wo.ticket_id
         WHERE t.symptom LIKE ${PREFIX + '%'}
      )
    `);
    await tx.delete(tickets).where(like(tickets.symptom, `${PREFIX}%`));
  });
});

/** Заявка с нарядом, закрытая в заданный момент. */
async function makeClosedTicket(closedAt: Date): Promise<{ ticketId: string; woId: string }> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${PREFIX}case`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.update(workOrders).set({ engineerId }).where(eq(workOrders.id, wo.id)),
  );
  await changeStatus(getDb(), erfolgId, null, ticketId, 'closed');
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.update(tickets).set({ closedAt }).where(eq(tickets.id, ticketId)),
  );
  return { ticketId, woId: wo.id };
}

describe('зарплата не начисляется по работам старой системы', () => {
  it('строка работ, перенесённая импортом, в ведомость не попадает', async () => {
    const closedAt = new Date('2019-03-14T10:00:00Z');
    const { woId } = await makeClosedTicket(closedAt);

    // Своя строка работ — 1000 ₽, и перенесённая — 900 000 ₽ (идентификатор версии 5).
    await upsertLine(getDb(), erfolgId, woId, null, {
      lineType: 'work',
      name: `${PREFIX}своя`,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: 100_000n,
      engineerId,
    });
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`
        INSERT INTO work_order_lines
          (id, tenant_id, work_order_id, line_type, name, unit, quantity,
           unit_price_kopecks, amount_kopecks, engineer_id)
        VALUES (${LEGACY_LINE_ID}::uuid, ${erfolgId}::uuid, ${woId}::uuid, 'work',
                ${PREFIX + 'перенос'}, 'шт', 1, 90000000, 90000000, ${engineerId}::uuid)
      `),
    );

    const result = await computePayouts(getDb(), erfolgId, {
      start: new Date('2019-03-01T00:00:00Z'),
      end: new Date('2019-04-01T00:00:00Z'),
    });
    const mine = result.rows.find((r) => r.engineerId === engineerId);
    expect(mine).toBeTruthy();
    // Считаем только свою строку: 100 000 копеек, а не 90 100 000.
    expect(mine!.worksAmountKopecks).toBe('100000');
  });

  it('перенесённая строка не начисляется и уволенному, которого разблокировали', async () => {
    const closedAt = new Date('2019-03-14T10:00:00Z');
    const { woId } = await makeClosedTicket(closedAt);
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`
        INSERT INTO work_order_lines
          (id, tenant_id, work_order_id, line_type, name, unit, quantity,
           unit_price_kopecks, amount_kopecks, engineer_id)
        VALUES (${LEGACY_LINE_ID}::uuid, ${erfolgId}::uuid, ${woId}::uuid, 'work',
                ${PREFIX + 'перенос'}, 'шт', 1, 90000000, 90000000, ${engineerId}::uuid)
      `),
    );

    const result = await computePayouts(getDb(), erfolgId, {
      start: new Date('2019-03-01T00:00:00Z'),
      end: new Date('2019-04-01T00:00:00Z'),
    });
    const mine = result.rows.find((r) => r.engineerId === engineerId);
    // Либо человека нет в ведомости вовсе, либо он есть с нулём работ — но не с 900 000 ₽.
    expect(mine?.worksAmountKopecks ?? '0').toBe('0');
  });
});

describe('оплата, перенесённая из старой системы, не стирается', () => {
  it('первый платёж CRM добавляется к исторической оплате, а не заменяет её', async () => {
    const { ticketId, woId } = await makeClosedTicket(new Date('2019-03-14T10:00:00Z'));
    // Так выглядит наряд после импорта: в шапке оплата старой программы, строк платежей нет.
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .update(workOrders)
        .set({ paidAmountKopecks: 50_000n, totalAmountKopecks: 200_000n })
        .where(eq(workOrders.id, woId)),
    );

    await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 10_000n,
      method: 'cash',
      paidAt: new Date('2019-03-16T10:00:00Z'),
      comment: `${PREFIX}первый платёж`,
      userId: null,
    });

    const [wo] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ paid: workOrders.paidAmountKopecks })
        .from(workOrders)
        .where(eq(workOrders.id, woId)),
    );
    expect(wo!.paid).toBe(60_000n);
  });

  it('после удаления платежа историческая оплата остаётся', async () => {
    const { ticketId, woId } = await makeClosedTicket(new Date('2019-03-14T10:00:00Z'));
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .update(workOrders)
        .set({ paidAmountKopecks: 50_000n, totalAmountKopecks: 200_000n })
        .where(eq(workOrders.id, woId)),
    );
    await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 10_000n,
      method: 'cash',
      paidAt: new Date('2019-03-16T10:00:00Z'),
      comment: `${PREFIX}отменяемый`,
      userId: null,
    });
    const list = await listByTicket(getDb(), erfolgId, ticketId);
    await deletePayment(getDb(), erfolgId, list[0]!.id);

    const [wo] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ paid: workOrders.paidAmountKopecks })
        .from(workOrders)
        .where(eq(workOrders.id, woId)),
    );
    expect(wo!.paid).toBe(50_000n);
  });

  it('у обычного наряда поведение прежнее: оплата равна сумме платежей', async () => {
    const { ticketId, woId } = await makeClosedTicket(new Date('2019-03-14T10:00:00Z'));
    await addPayment(getDb(), erfolgId, {
      ticketId,
      amountKopecks: 30_000n,
      method: 'cash',
      paidAt: new Date('2019-03-16T10:00:00Z'),
      comment: `${PREFIX}обычный`,
      userId: null,
    });
    const [wo] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ paid: workOrders.paidAmountKopecks })
        .from(workOrders)
        .where(eq(workOrders.id, woId)),
    );
    expect(wo!.paid).toBe(30_000n);
  });
});
