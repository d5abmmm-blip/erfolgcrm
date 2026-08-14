/**
 * Массовая отметка периода в табеле — «внёс отпуск, проставилось и в журнале».
 *
 * Решение владельца 2026-08-14: отпуск живёт в двух местах (план «Отсутствия» и факт
 * «Табель»), связывать их автоматически НЕ будем — только по галочке человека. Отсюда
 * отдельная процедура, а не побочный эффект setAvailability.
 *
 * Правила, ради которых она вообще существует:
 *   • уже отмеченный день НЕ переписывается — в табеле лежит факт, который кто-то
 *     ставил руками, и массовая заливка не имеет права его затирать;
 *   • явку оптом не ставят: это факт по дням, у каждого своё время прихода;
 *   • период ограничен — опечатка в году не должна залить табель на сто лет вперёд.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, gte, lte } from 'drizzle-orm';
import { attendanceRecords, getDb, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { enumerateDays, monthRange } from '../modules/attendance/service';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

/** Свой «мёртвый» месяц — соседний файл про табель занимает март 2019. */
const YEAR = 2019;
const MONTH = 4;

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

/** Отметки сотрудника за тестовый месяц, по возрастанию даты. */
async function recordsOfMonth() {
  const { from, to } = monthRange(YEAR, MONTH);
  return withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({
        workDate: attendanceRecords.workDate,
        status: attendanceRecords.status,
        arrivedAt: attendanceRecords.arrivedAt,
      })
      .from(attendanceRecords)
      .where(and(gte(attendanceRecords.workDate, from), lte(attendanceRecords.workDate, to)))
      .orderBy(attendanceRecords.workDate),
  );
}

describe('перечисление дней периода', () => {
  it('включает обе границы', () => {
    expect(enumerateDays('2019-04-05', '2019-04-08')).toEqual([
      '2019-04-05',
      '2019-04-06',
      '2019-04-07',
      '2019-04-08',
    ]);
  });

  it('один день — один элемент', () => {
    expect(enumerateDays('2019-04-05', '2019-04-05')).toEqual(['2019-04-05']);
  });

  it('переходит через конец месяца и через февраль високосного года', () => {
    expect(enumerateDays('2019-04-29', '2019-05-01')).toEqual([
      '2019-04-29',
      '2019-04-30',
      '2019-05-01',
    ]);
    expect(enumerateDays('2024-02-28', '2024-03-01')).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
  });

  it('конец раньше начала — пусто, а не бесконечный цикл', () => {
    expect(enumerateDays('2019-04-10', '2019-04-01')).toEqual([]);
  });
});

describe('массовая отметка периода в табеле', () => {
  it('проставляет отпуск на все дни периода, включая выходные', async () => {
    const res = await staff().attendance.fillRange({
      userId: engineerId,
      dateFrom: '2019-04-05',
      dateTo: '2019-04-09',
      status: 'vacation',
    });
    expect(res).toEqual({ created: 5, skipped: 0 });

    const rows = await recordsOfMonth();
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === 'vacation')).toBe(true);
    // 6 и 7 апреля 2019 — суббота и воскресенье: отпуск идёт календарными днями,
    // иначе в распечатанном табеле внутри отпуска зияли бы дырки.
    expect(rows.map((r) => r.workDate)).toContain('2019-04-06');
    expect(rows.map((r) => r.workDate)).toContain('2019-04-07');
  });

  it('уже отмеченный день не переписывается', async () => {
    await staff().attendance.upsert({
      userId: engineerId,
      workDate: '2019-04-06',
      status: 'present',
      arrivedAt: '09:00',
      leftAt: '18:00',
    });

    const res = await staff().attendance.fillRange({
      userId: engineerId,
      dateFrom: '2019-04-05',
      dateTo: '2019-04-09',
      status: 'vacation',
    });
    expect(res).toEqual({ created: 4, skipped: 1 });

    const rows = await recordsOfMonth();
    const kept = rows.find((r) => r.workDate === '2019-04-06');
    expect(kept?.status).toBe('present');
    expect(kept?.arrivedAt).toBe('09:00:00');
  });

  it('повторный запуск ничего не меняет — всё уже отмечено', async () => {
    const first = await staff().attendance.fillRange({
      userId: engineerId,
      dateFrom: '2019-04-05',
      dateTo: '2019-04-07',
      status: 'day_off',
    });
    expect(first.created).toBe(3);

    const second = await staff().attendance.fillRange({
      userId: engineerId,
      dateFrom: '2019-04-05',
      dateTo: '2019-04-07',
      status: 'day_off',
    });
    expect(second).toEqual({ created: 0, skipped: 3 });
    expect(await recordsOfMonth()).toHaveLength(3);
  });

  it('явку оптом не ставят — это факт по дням', async () => {
    await expect(
      staff().attendance.fillRange({
        userId: engineerId,
        dateFrom: '2019-04-05',
        dateTo: '2019-04-09',
        status: 'present',
      }),
    ).rejects.toThrow(/явк/i);
    expect(await recordsOfMonth()).toHaveLength(0);
  });

  it('конец периода раньше начала не принимается', async () => {
    await expect(
      staff().attendance.fillRange({
        userId: engineerId,
        dateFrom: '2019-04-09',
        dateTo: '2019-04-05',
        status: 'vacation',
      }),
    ).rejects.toThrow(/раньше/i);
  });

  it('слишком длинный период не принимается — защита от опечатки в годе', async () => {
    await expect(
      staff().attendance.fillRange({
        userId: engineerId,
        dateFrom: '2019-04-05',
        dateTo: '2119-04-05',
        status: 'vacation',
      }),
    ).rejects.toThrow(/период/i);
    expect(await recordsOfMonth()).toHaveLength(0);
  });

  it('отметка на несуществующего сотрудника не проходит', async () => {
    await expect(
      staff().attendance.fillRange({
        userId: '00000000-0000-0000-0000-0000000000ff',
        dateFrom: '2019-04-05',
        dateTo: '2019-04-09',
        status: 'vacation',
      }),
    ).rejects.toThrow(/не найден/i);
  });

  it('инженеру недоступна', async () => {
    const engineer = appRouter.createCaller(makeCtx('engineer'));
    await expect(
      engineer.attendance.fillRange({
        userId: engineerId,
        dateFrom: '2019-04-05',
        dateTo: '2019-04-09',
        status: 'vacation',
      }),
    ).rejects.toThrow(/Доступ только для ролей/i);
  });
});
