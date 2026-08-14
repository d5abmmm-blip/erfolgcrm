/**
 * Раздел «Сотрудники»: текущая загрузка считается только по своим данным.
 *
 * Почему это отдельный тест, а не «и так понятно». В боевой базе 58 незакрытых
 * заявок пришли из прежней системы: 41 висит на неактивном «Администраторе», у
 * живого инженера числится «в работе» заявка от февраля 2015 года. Если посчитать
 * загрузку в лоб, экран назначения покажет занятыми тех, кто свободен, и менеджер
 * будет распределять работу по вымышленным числам.
 *
 * Правило: в загрузку идут только заявки, заведённые в CRM (created_at >= STATS_SINCE).
 * Архивные не пропадают — они считаются отдельным числом и показываются отдельно.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { STATS_SINCE } from '../lib/stats-since';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-STAFF-LOAD-';

let erfolgId = '';
let engineerId = '';
let dispatcherId = '';
let clientId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const eng = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!eng || !disp) throw new Error('seed missing engineer/dispatcher');
  engineerId = eng.id;
  dispatcherId = disp.id;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(tickets).where(like(tickets.ticketNumber, `${TEST_PREFIX}%`)),
  );
});

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(role: 'director' | 'dispatcher' | 'engineer'): Context {
  const session: SessionData = {
    tenantId: erfolgId,
    userId: role === 'engineer' ? engineerId : dispatcherId,
    username: `${role}-test`,
    role,
    fullName: `Test ${role}`,
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
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
  };
}

const staff = () => appRouter.createCaller(makeCtx('dispatcher'));

/** Заявка «в работе» с заданной датой создания — так мы и разводим архив и своё. */
async function makeOpenTicket(suffix: string, createdAt: Date, deadlineAt: Date | null = null) {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.insert(tickets).values({
      tenantId: erfolgId,
      clientId,
      ticketNumber: `${TEST_PREFIX}${suffix}`,
      // barcode короче ticket_number по длине колонки — свой компактный ключ.
      barcode: `TSL-${suffix}`,
      status: 'in_progress',
      assignedEngineerId: engineerId,
      receivedAt: createdAt,
      createdAt,
      deadlineAt,
    }),
  );
}

const dayBefore = (d: Date, days: number) => new Date(d.getTime() - days * 86400000);
const dayAfter = (d: Date, days: number) => new Date(d.getTime() + days * 86400000);

async function loadOf(userId: string) {
  const res = await staff().staff.list({ includeBlocked: true });
  const row = res.rows.find((r) => r.userId === userId);
  if (!row) throw new Error('сотрудник не найден в списке');
  return row;
}

/**
 * В тестовой базе у инженера уже есть заявки из сидов, поэтому проверяем ПРИРАЩЕНИЕ,
 * а не абсолютные числа: так тест не зависит от того, что лежало в базе до него.
 */
async function loadDelta(userId: string, act: () => Promise<void>) {
  const before = await loadOf(userId);
  await act();
  const after = await loadOf(userId);
  return {
    open: after.openTickets - before.openTickets,
    overdue: after.overdueTickets - before.overdueTickets,
    archive: after.archiveOpenTickets - before.archiveOpenTickets,
  };
}

describe('раздел «Сотрудники» — доступ', () => {
  it('инженеру раздел закрыт', async () => {
    const engineer = appRouter.createCaller(makeCtx('engineer'));
    await expect(engineer.staff.list()).rejects.toThrow(/Доступ только для ролей/i);
    await expect(engineer.staff.get({ userId: engineerId })).rejects.toThrow(
      /Доступ только для ролей/i,
    );
  });

  it('менеджер раздел видит', async () => {
    await expect(staff().staff.list()).resolves.toBeTruthy();
  });
});

describe('текущая загрузка — архив не считается', () => {
  it('заявка из архива в загрузку НЕ идёт, но видна отдельным числом', async () => {
    const d = await loadDelta(engineerId, () =>
      makeOpenTicket('archive', dayBefore(STATS_SINCE, 400)),
    );
    expect(d.open).toBe(0);
    expect(d.archive).toBe(1);
  });

  it('заявка, заведённая в CRM, идёт в загрузку', async () => {
    const d = await loadDelta(engineerId, () => makeOpenTicket('own', dayAfter(STATS_SINCE, 10)));
    expect(d.open).toBe(1);
    expect(d.archive).toBe(0);
  });

  it('архив и своё считаются раздельно и не смешиваются', async () => {
    const d = await loadDelta(engineerId, async () => {
      await makeOpenTicket('a1', dayBefore(STATS_SINCE, 900));
      await makeOpenTicket('a2', dayBefore(STATS_SINCE, 30));
      await makeOpenTicket('own1', dayAfter(STATS_SINCE, 1));
    });
    expect(d.open).toBe(1);
    expect(d.archive).toBe(2);
  });

  it('просроченной считается только своя заявка с прошедшим сроком', async () => {
    const now = new Date();
    const d = await loadDelta(engineerId, async () => {
      await makeOpenTicket('overdue', dayAfter(STATS_SINCE, 5), dayBefore(now, 3));
      await makeOpenTicket('intime', dayAfter(STATS_SINCE, 5), dayAfter(now, 30));
      // Архивная просрочка не должна поднимать счётчик — она не в работе.
      await makeOpenTicket('arch-over', dayBefore(STATS_SINCE, 100), dayBefore(now, 500));
    });
    expect(d.open).toBe(2);
    expect(d.overdue).toBe(1);
    expect(d.archive).toBe(1);
  });
});

describe('карточка сотрудника', () => {
  it('в списке заявок карточки только свои, архивные — числом', async () => {
    await makeOpenTicket('card-own', dayAfter(STATS_SINCE, 2));
    await makeOpenTicket('card-archive', dayBefore(STATS_SINCE, 200));

    const { card } = await staff().staff.get({ userId: engineerId });
    const mine = card.openTicketList.filter((t) => t.ticketNumber.startsWith(TEST_PREFIX));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.ticketNumber).toBe(`${TEST_PREFIX}card-own`);
    expect(card.archiveOpenTickets).toBeGreaterThanOrEqual(1);
  });

  it('несуществующий сотрудник — понятная ошибка, а не пустая карточка', async () => {
    await expect(
      staff().staff.get({ userId: '00000000-0000-0000-0000-0000000000ff' }),
    ).rejects.toThrow(/не найден/i);
  });

  it('карточка отдаёт дату отсечки, чтобы экран мог honest-подписать цифры', async () => {
    const res = await staff().staff.get({ userId: engineerId });
    expect(res.statsSince).toEqual(STATS_SINCE);
    expect(res.statsSinceLabel).toMatch(/CRM/);
  });
});
