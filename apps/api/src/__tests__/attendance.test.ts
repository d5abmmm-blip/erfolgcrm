/**
 * Журнал посещений (табель): правила заполнения и доступ.
 *
 * Смысл правил один — табель фиксирует ФАКТ, а не план, и должен быть однозначным:
 *   • время прихода/ухода бывает только у явки;
 *   • уход позже прихода, ухода без прихода не бывает;
 *   • явку нельзя поставить будущим днём (отпуск и больничный — можно, их планируют);
 *   • у сотрудника на день ровно одна отметка, повторная запись правит её же.
 *
 * Доступ — только директор и диспетчер: журнал ведут в десктопной CRM, у инженера
 * отметок «пришёл/ушёл» нет вовсе.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, gte, lte } from 'drizzle-orm';
import { attendanceRecords, getDb, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { monthRange, todayInTimezone } from '../modules/attendance/service';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

/** Песочница — заведомо «мёртвый» месяц, чтобы не пересечься с живыми данными. */
const YEAR = 2019;
const MONTH = 3;
const DAY = `${YEAR}-03-14`;

let erfolgId = '';
let engineerId = '';
let dispatcherId = '';
let directorId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const eng = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  const dir = usrs.find((u) => u.role === 'director');
  if (!eng || !disp || !dir) throw new Error('seed missing engineer/dispatcher/director');
  engineerId = eng.id;
  dispatcherId = disp.id;
  directorId = dir.id;
});

beforeEach(async () => {
  const { from, to } = monthRange(YEAR, MONTH);
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .delete(attendanceRecords)
      .where(and(gte(attendanceRecords.workDate, from), lte(attendanceRecords.workDate, to))),
  );
});

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(role: 'director' | 'dispatcher' | 'engineer'): Context {
  const userId =
    role === 'engineer' ? engineerId : role === 'dispatcher' ? dispatcherId : directorId;
  const session: SessionData = {
    tenantId: erfolgId,
    userId,
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

/** Завтра в таймзоне организации — граница правила «явка только фактом». */
function tomorrowInMoscow(): string {
  const today = todayInTimezone('Europe/Moscow');
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('границы месяца', () => {
  it('февраль високосного и невисокосного года считается верно', () => {
    expect(monthRange(2024, 2)).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('декабрь не перескакивает в следующий год', () => {
    expect(monthRange(2026, 12)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});

describe('сегодня в таймзоне организации', () => {
  it('поздний вечер по Москве — это уже следующая дата, хотя по UTC ещё нет', () => {
    // 21:30 UTC = 00:30 следующего дня в Москве (UTC+3).
    expect(todayInTimezone('Europe/Moscow', new Date('2026-08-14T21:30:00Z'))).toBe('2026-08-15');
  });
});

describe('журнал посещений — доступ', () => {
  it('инженер не видит журнал и не может его править', async () => {
    const engineer = appRouter.createCaller(makeCtx('engineer'));
    await expect(engineer.attendance.month({ year: YEAR, month: MONTH })).rejects.toThrow(
      /Доступ только для ролей/i,
    );
    await expect(
      engineer.attendance.upsert({ userId: engineerId, workDate: DAY, status: 'present' }),
    ).rejects.toThrow(/Доступ только для ролей/i);
    await expect(engineer.attendance.remove({ userId: engineerId, workDate: DAY })).rejects.toThrow(
      /Доступ только для ролей/i,
    );
  });
});

describe('журнал посещений — правила заполнения', () => {
  it('время прихода бывает только у явки', async () => {
    await expect(
      staff().attendance.upsert({
        userId: engineerId,
        workDate: DAY,
        status: 'sick',
        arrivedAt: '09:00',
      }),
    ).rejects.toThrow(/только у явки/i);
  });

  it('уход раньше прихода не принимается', async () => {
    await expect(
      staff().attendance.upsert({
        userId: engineerId,
        workDate: DAY,
        status: 'present',
        arrivedAt: '18:00',
        leftAt: '09:00',
      }),
    ).rejects.toThrow(/позже прихода/i);
  });

  it('уход в ту же минуту, что и приход, не принимается', async () => {
    await expect(
      staff().attendance.upsert({
        userId: engineerId,
        workDate: DAY,
        status: 'present',
        arrivedAt: '09:00',
        leftAt: '09:00',
      }),
    ).rejects.toThrow(/позже прихода/i);
  });

  it('уход без прихода не принимается', async () => {
    await expect(
      staff().attendance.upsert({
        userId: engineerId,
        workDate: DAY,
        status: 'present',
        leftAt: '18:00',
      }),
    ).rejects.toThrow(/время прихода/i);
  });

  it('явку нельзя поставить будущим днём', async () => {
    await expect(
      staff().attendance.upsert({
        userId: engineerId,
        workDate: tomorrowInMoscow(),
        status: 'present',
      }),
    ).rejects.toThrow(/будущим днём/i);
  });

  it('отпуск будущим днём поставить можно — его планируют заранее', async () => {
    const workDate = tomorrowInMoscow();
    await expect(
      staff().attendance.upsert({ userId: engineerId, workDate, status: 'vacation' }),
    ).resolves.toBeTruthy();
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .delete(attendanceRecords)
        .where(
          and(gte(attendanceRecords.workDate, workDate), lte(attendanceRecords.workDate, workDate)),
        ),
    );
  });

  it('отметка на чужого пользователя не проходит', async () => {
    await expect(
      staff().attendance.upsert({
        userId: '00000000-0000-0000-0000-0000000000ff',
        workDate: DAY,
        status: 'present',
      }),
    ).rejects.toThrow(/не найден/i);
  });
});

describe('журнал посещений — одна отметка на день', () => {
  it('повторная запись правит тот же день, а не заводит вторую строку', async () => {
    const caller = staff();
    await caller.attendance.upsert({
      userId: engineerId,
      workDate: DAY,
      status: 'present',
      arrivedAt: '09:00',
      leftAt: '18:00',
    });
    await caller.attendance.upsert({
      userId: engineerId,
      workDate: DAY,
      status: 'present',
      arrivedAt: '10:00',
      leftAt: '17:00',
      note: 'по согласованию',
    });

    const month = await caller.attendance.month({ year: YEAR, month: MONTH });
    const mine = month.records.filter((r) => r.userId === engineerId && r.workDate === DAY);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.arrivedAt).toBe('10:00');
    expect(mine[0]?.leftAt).toBe('17:00');
    expect(mine[0]?.note).toBe('по согласованию');
  });

  it('снятая отметка исчезает из месяца', async () => {
    const caller = staff();
    await caller.attendance.upsert({ userId: engineerId, workDate: DAY, status: 'day_off' });
    await expect(caller.attendance.remove({ userId: engineerId, workDate: DAY })).resolves.toEqual({
      removed: true,
    });

    const month = await caller.attendance.month({ year: YEAR, month: MONTH });
    expect(month.records.filter((r) => r.workDate === DAY)).toHaveLength(0);
  });

  it('месяц отдаёт сотрудников даже когда отметок нет', async () => {
    const month = await staff().attendance.month({ year: YEAR, month: MONTH });
    expect(month.records).toHaveLength(0);
    expect(month.employees.some((e) => e.userId === engineerId)).toBe(true);
    expect(month.from).toBe('2019-03-01');
    expect(month.to).toBe('2019-03-31');
  });
});
