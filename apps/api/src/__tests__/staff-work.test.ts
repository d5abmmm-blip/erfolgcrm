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
 * 2. Работа засчитывается по дате, когда её СДЕЛАЛИ (решение владельца 2026-08-15).
 *    Если инженер сегодня закрывает заявку, заведённую ещё в старой программе, — это
 *    его сегодняшний труд, и он обязан попасть в статистику. Отсечка STATS_SINCE
 *    остаётся, но накладывается на дату закрытия: то, что закрыли ДО запуска CRM,
 *    по людям не разложено (работали под одной учёткой) и человеку не приписывается.
 *
 * 3. Ни одной суммы в копейках. Карточка открыта менеджеру, деньги по человеку —
 *    только директору и только на своей вкладке.
 *
 * ⚠️ Окна периодов здесь — 2031 год, и это НЕ опечатка. getStaffWork считает ВСЕ
 * заявки сид-инженера, а соседние тест-файлы (payroll, e2e, dashboard-metrics…)
 * закрывают заявки на том же инженере: changeStatus ставит closed_at = сейчас, и
 * до подмены даты заявка мгновение живёт «закрытой в текущем месяце». Vitest
 * гоняет файлы параллельно — окно на ТЕКУЩЕМ месяце ловило чужую заявку и падало
 * («expected 2 to be 1», CI на PR #148). В 2031-м заявок не закрывает никто.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket, changeStatus } from '../modules/tickets/repository';
import { getStaffWork } from '../modules/staff/repository';

const PREFIX = 'TEST-STAFFWORK-';
const LEGACY_TICKET_ID = '3f2504e0-4f89-51d3-9a0c-0305e82c3b02';
const LEGACY_OLD_CLOSED_ID = '3f2504e0-4f89-51d3-9a0c-0305e82c3b03';

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

const PERIOD = { from: new Date('2031-08-01T00:00:00Z'), to: new Date('2031-09-01T00:00:00Z') };

describe('период считается по дате закрытия', () => {
  it('закрытая внутри периода попадает, закрытая раньше — нет', async () => {
    await closedTicket(new Date('2031-08-15T12:00:00Z'));
    await closedTicket(new Date('2031-07-15T12:00:00Z'));

    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(work.totals.closedInPeriod).toBe(1);
  });

  it('граница периода — полуинтервал: последний день входит, первый день следующего нет', async () => {
    await closedTicket(new Date('2031-08-31T23:59:00Z'));
    await closedTicket(new Date('2031-09-01T00:00:01Z'));

    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(work.totals.closedInPeriod).toBe(1);
  });
});

describe('работа считается по дате закрытия, а не заведения', () => {
  it('старая заявка, закрытая инженером в этом периоде, засчитывается ему', async () => {
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`
        INSERT INTO tickets
          (id, tenant_id, ticket_number, barcode, client_id, assigned_engineer_id, status,
           symptom, received_at, created_at, closed_at)
        VALUES (${LEGACY_TICKET_ID}::uuid, ${erfolgId}::uuid, ${'WSP-' + PREFIX},
                ${'BC-' + PREFIX}, ${clientId}::uuid, ${engineerId}::uuid, 'closed',
                ${PREFIX + 'архивная'}, '2015-02-08T09:00:00Z', '2015-02-08T09:00:00Z',
                '2031-08-15T10:00:00Z')
      `),
    );

    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(work.totals.closedInPeriod).toBe(1);
  });

  it('но закрытая ещё в старой программе — не засчитывается никому', async () => {
    // Закрыта в 2015-м, до запуска CRM: кто именно работал, в перенесённых данных не
    // сохранилось — там всё делали под одной учётной записью.
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`
        INSERT INTO tickets
          (id, tenant_id, ticket_number, barcode, client_id, assigned_engineer_id, status,
           symptom, received_at, created_at, closed_at)
        VALUES (${LEGACY_OLD_CLOSED_ID}::uuid, ${erfolgId}::uuid, ${'WSP-OLD-' + PREFIX},
                ${'BC-OLD-' + PREFIX}, ${clientId}::uuid, ${engineerId}::uuid, 'closed',
                ${PREFIX + 'закрыта в 2015'}, '2015-02-08T09:00:00Z', '2015-02-08T09:00:00Z',
                '2015-03-01T10:00:00Z')
      `),
    );

    const work = await getStaffWork(getDb(), erfolgId, engineerId, {
      from: new Date('2015-01-01T00:00:00Z'),
      to: new Date('2030-01-01T00:00:00Z'),
    });
    expect(work.recent.some((t) => t.ticketNumber.startsWith('WSP-OLD-'))).toBe(false);
  });
});

describe('разрезы', () => {
  it('по неделям: пустые недели остаются в ряду, иначе график порвётся', async () => {
    await closedTicket(new Date('2031-08-05T12:00:00Z'));
    await closedTicket(new Date('2031-08-26T12:00:00Z'));

    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(work.byWeek.length).toBeGreaterThanOrEqual(4);
    expect(work.byWeek.reduce((a, w) => a + w.closed, 0)).toBe(2);
    // Есть неделя с нулём — значит ряд не схлопнут.
    expect(work.byWeek.some((w) => w.closed === 0)).toBe(true);
  });

  it('по клиентам считает закрытые за период', async () => {
    await closedTicket(new Date('2031-08-15T12:00:00Z'));
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
    await closedTicket(new Date('2031-08-15T12:00:00Z'));
    const work = await getStaffWork(getDb(), erfolgId, engineerId, PERIOD);
    expect(JSON.stringify(work)).not.toMatch(/kopeck/i);
  });
});
