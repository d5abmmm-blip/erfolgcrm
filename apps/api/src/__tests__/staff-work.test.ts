/**
 * Вкладка «Работа» на карточке сотрудника: что человек сделал за период.
 *
 * Три правила, ради которых здесь тесты:
 *
 * 1. Ось периода — ДАТА ЗАКРЫТИЯ, а не заведения. Человек, выбирая «за месяц», ждёт
 *    «закрыто в этом месяце». В отчётах период накладывается на дату создания, и там
 *    «закрыл за август» означает «заведена в августе» — на карточке это выглядело бы
 *    как чужая цифра.
 *
 * 2. Считаем только заявки, заведённые в CRM (STATS_SINCE). В перенесённом архиве
 *    исполнителя фактически нет: работали под одной учёткой, и 5999 чужих заявок
 *    приписались бы живому человеку.
 *
 * 3. Ни одной суммы в копейках. Карточка открыта менеджеру, деньги по человеку —
 *    только директору и только на своей вкладке.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket, changeStatus } from '../modules/tickets/repository';
import { getStaffWork } from '../modules/staff/repository';

const PREFIX = 'TEST-STAFFWORK-';
const LEGACY_TICKET_ID = '3f2504e0-4f89-51d3-9a0c-0305e82c3b02';

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
    await tx.delete(tickets).where(like(tickets.symptom, `${PREFIX}%`));
  });
});

/** Своя заявка CRM, закрытая в заданный момент. */
async function closedTicket(closedAt: Date, createdAt = new Date('2026-07-20T09:00:00Z')) {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${PREFIX}своя`,
    assignedEngineerId: engineerId,
  });
  await changeStatus(getDb(), erfolgId, null, id, 'closed');
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.update(tickets).set({ closedAt, createdAt }).where(eq(tickets.id, id)),
  );
  return id;
}

const PERIOD = { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') };

describe('период считается по дате закрытия', () => {
  it('закрытая внутри периода попадает, закрытая раньше — нет', async () => {
    await closedTicket(new Date('2026-08-15T12:00:00Z'));
    await closedTicket(new Date('2026-07-15T12:00:00Z'));

    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(work.totals.closedInPeriod).toBe(1);
  });

  it('граница периода — полуинтервал: последний день входит, первый день следующего нет', async () => {
    await closedTicket(new Date('2026-08-31T23:59:00Z'));
    await closedTicket(new Date('2026-09-01T00:00:01Z'));

    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(work.totals.closedInPeriod).toBe(1);
  });
});

describe('архив старой системы в работу человека не идёт', () => {
  it('перенесённая заявка, закрытая в периоде, не считается', async () => {
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`
        INSERT INTO tickets
          (id, tenant_id, ticket_number, barcode, client_id, assigned_engineer_id, status,
           symptom, received_at, created_at, closed_at)
        VALUES (${LEGACY_TICKET_ID}::uuid, ${erfolgId}::uuid, ${'WSP-' + PREFIX},
                ${'BC-' + PREFIX}, ${clientId}::uuid, ${engineerId}::uuid, 'closed',
                ${PREFIX + 'архивная'}, '2015-02-08T09:00:00Z', '2015-02-08T09:00:00Z',
                '2026-08-15T10:00:00Z')
      `),
    );

    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(work.totals.closedInPeriod).toBe(0);
  });
});

describe('разрезы', () => {
  it('по неделям: пустые недели остаются в ряду, иначе график порвётся', async () => {
    await closedTicket(new Date('2026-08-05T12:00:00Z'));
    await closedTicket(new Date('2026-08-26T12:00:00Z'));

    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(work.byWeek.length).toBeGreaterThanOrEqual(4);
    expect(work.byWeek.reduce((a, w) => a + w.closed, 0)).toBe(2);
    // Есть неделя с нулём — значит ряд не схлопнут.
    expect(work.byWeek.some((w) => w.closed === 0)).toBe(true);
  });

  it('по клиентам считает закрытые за период', async () => {
    await closedTicket(new Date('2026-08-15T12:00:00Z'));
    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    const row = work.topClients.find((c) => c.clientId === clientId);
    expect(row?.closed).toBe(1);
  });

  it('текущие статусы считаются без периода — это срез «что на человеке сейчас»', async () => {
    const { id } = await createTicket(getDb(), erfolgId, null, {
      clientId,
      symptom: `${PREFIX}в работе`,
      assignedEngineerId: engineerId,
    });
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');

    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    const inProgress = work.byStatus.find((s) => s.status === 'in_progress');
    expect(inProgress?.count).toBeGreaterThanOrEqual(1);
  });
});

describe('деньги на этой вкладке не отдаются вовсе', () => {
  it('в ответе нет ни одного поля с копейками', async () => {
    await closedTicket(new Date('2026-08-15T12:00:00Z'));
    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(JSON.stringify(work)).not.toMatch(/kopeck/i);
  });
});
