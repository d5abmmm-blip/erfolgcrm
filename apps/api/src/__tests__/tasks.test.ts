/**
 * Тесты задач менеджеров (modules/tasks):
 *   • CRUD репозитория: создание с датой/без, обновление, сделано, soft-delete;
 *   • сортировка (открытые сверху, дата nulls last);
 *   • listMyTasks фильтрует по исполнителю;
 *   • cross-tenant: задачи demo не видны из erfolg (RLS);
 *   • assertEngineerOwnsTask: инженер — только свои, staff — насквозь;
 *   • setTaskDoneCmd: инженер не может закрыть чужую задачу (FORBIDDEN);
 *   • воркер task-reminder: шлёт push, помечает reminded_at, повторно не шлёт.
 *
 * Ходит в erfolg_test (RLS через withTenantTx). Префикс TESTTASK- + чистка в afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, withTenantTx } from '@erfolg/db';
import { TRPCError } from '@trpc/server';
import { ensureSeed } from './setup';
import {
  createTask,
  getTask,
  listMyTasks,
  listTasks,
  listDueTaskReminders,
  setTaskDone,
  softDeleteTask,
  updateTask,
} from '../modules/tasks/repository';
import { assertEngineerOwnsTask, createTaskCmd, setTaskDoneCmd } from '../modules/tasks/service';
import { processTaskReminderTick } from '../workers/task-reminder';
import type { CmdCtx } from '../trpc/helpers';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TESTTASK-';
const TZ = 'Europe/Moscow';
const ENG1 = '00000000-0000-4000-8000-0000000000e1';
const ENG2 = '00000000-0000-4000-8000-0000000000e2';

let erfolgId = '';
let demoId = '';
let directorId = '';

/** Минимальный CmdCtx для прямого вызова service-команд в тестах. */
function ctxFor(
  tenantId: string,
  userId: string,
  role: 'director' | 'dispatcher' | 'engineer',
): CmdCtx {
  return {
    db: getDb(),
    tenant: { id: tenantId, timezone: TZ } as unknown as ResolvedTenant,
    session: { tenantId, userId, role } as unknown as SessionData,
    audit: { ip: null, userAgent: null },
    tenantId,
    userId,
    role,
    ip: null,
    userAgent: null,
  };
}

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  directorId = await withTenantTx(getDb(), erfolgId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE role = 'director' LIMIT 1`,
    );
    const id = (rows as unknown as Array<{ id: string }>)[0]?.id;
    if (!id) throw new Error('seed missing director');
    return id;
  });
});

afterAll(async () => {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, (tx) =>
      tx.execute(sql`DELETE FROM tasks WHERE title LIKE ${TEST_PREFIX + '%'}`),
    );
  }
});

describe('tasks — CRUD репозитория', () => {
  it('create с датой → в списке с полями; update меняет; setDone; soft-delete', async () => {
    const { id } = await createTask(getDb(), erfolgId, directorId, TZ, {
      title: `${TEST_PREFIX}Заказать бумагу`,
      date: '2031-03-18',
      time: '14:30',
      notes: 'В канцелярии',
      assigneeUserId: ENG1,
      remind: false,
    });

    let list = await listTasks(getDb(), erfolgId, {});
    const t = list.find((x) => x.id === id);
    expect(t?.title).toBe(`${TEST_PREFIX}Заказать бумагу`);
    expect(t?.dueDate).toBe('2031-03-18');
    expect(t?.dueTime).toBe('14:30');
    expect(t?.assigneeUserId).toBe(ENG1);
    expect(t?.isDone).toBe(false);

    // update — перенос без времени.
    expect(
      await updateTask(getDb(), erfolgId, id, TZ, {
        title: `${TEST_PREFIX}Заказать бумагу (перенос)`,
        date: '2031-03-20',
        time: null,
        notes: null,
        assigneeUserId: ENG1,
        remind: false,
      }),
    ).toBe(true);
    list = await listTasks(getDb(), erfolgId, {});
    expect(list.find((x) => x.id === id)?.dueDate).toBe('2031-03-20');
    expect(list.find((x) => x.id === id)?.dueTime).toBeNull();

    // setDone → задача ОСТАЁТСЯ в основном списке (выполнена недавно), помечена done.
    expect(await setTaskDone(getDb(), erfolgId, id, true, ENG1)).toBe(true);
    expect((await listTasks(getDb(), erfolgId, {})).find((x) => x.id === id)?.isDone).toBe(true);
    // «Состарим» выполнение на 4 дня → уходит из основного списка, но виден в «Все».
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`UPDATE tasks SET done_at = now() - interval '4 days' WHERE id = ${id}::uuid`),
    );
    expect((await listTasks(getDb(), erfolgId, {})).some((x) => x.id === id)).toBe(false);
    expect(
      (await listTasks(getDb(), erfolgId, { includeDone: true })).some((x) => x.id === id),
    ).toBe(true);

    // soft-delete — исчезает совсем, повторный delete → false.
    expect(await softDeleteTask(getDb(), erfolgId, id)).toBe(true);
    expect(
      (await listTasks(getDb(), erfolgId, { includeDone: true })).some((x) => x.id === id),
    ).toBe(false);
    expect(await softDeleteTask(getDb(), erfolgId, id)).toBe(false);
  });

  it('задача без даты создаётся и видна в списке', async () => {
    const { id } = await createTask(getDb(), erfolgId, directorId, TZ, {
      title: `${TEST_PREFIX}Позвонить поставщику`,
      date: null,
      time: null,
      notes: null,
      assigneeUserId: null,
      remind: false,
    });
    const t = (await listTasks(getDb(), erfolgId, {})).find((x) => x.id === id);
    expect(t).toBeTruthy();
    expect(t?.dueDate).toBeNull();
    expect(t?.assigneeUserId).toBeNull();
  });

  it('сортировка: открытые выше выполненных', async () => {
    const open = await createTask(getDb(), erfolgId, directorId, TZ, {
      title: `${TEST_PREFIX}Открытая`,
      date: null,
      time: null,
      notes: null,
      assigneeUserId: null,
      remind: false,
    });
    const done = await createTask(getDb(), erfolgId, directorId, TZ, {
      title: `${TEST_PREFIX}Выполненная`,
      date: null,
      time: null,
      notes: null,
      assigneeUserId: null,
      remind: false,
    });
    await setTaskDone(getDb(), erfolgId, done.id, true, directorId);

    const list = await listTasks(getDb(), erfolgId, { includeDone: true });
    const iOpen = list.findIndex((x) => x.id === open.id);
    const iDone = list.findIndex((x) => x.id === done.id);
    expect(iOpen).toBeGreaterThanOrEqual(0);
    expect(iDone).toBeGreaterThan(iOpen); // выполненная — ниже
  });
});

describe('tasks — listMyTasks по исполнителю', () => {
  it('возвращает только задачи назначенного инженера', async () => {
    const mine = await createTask(getDb(), erfolgId, directorId, TZ, {
      title: `${TEST_PREFIX}Моя`,
      date: null,
      time: null,
      notes: null,
      assigneeUserId: ENG1,
      remind: false,
    });
    const others = await createTask(getDb(), erfolgId, directorId, TZ, {
      title: `${TEST_PREFIX}Чужая`,
      date: null,
      time: null,
      notes: null,
      assigneeUserId: ENG2,
      remind: false,
    });
    const my = await listMyTasks(getDb(), erfolgId, ENG1, {});
    expect(my.some((x) => x.id === mine.id)).toBe(true);
    expect(my.some((x) => x.id === others.id)).toBe(false);
  });
});

describe('tasks — cross-tenant (RLS)', () => {
  it('задача demo не видна из erfolg; getTask/softDelete из чужого tenant → пусто/false', async () => {
    const { id } = await createTask(getDb(), demoId, null, TZ, {
      title: `${TEST_PREFIX}demo-задача`,
      date: null,
      time: null,
      notes: null,
      assigneeUserId: null,
      remind: false,
    });
    expect(
      (await listTasks(getDb(), erfolgId, { includeDone: true })).some((x) => x.id === id),
    ).toBe(false);
    expect(await getTask(getDb(), erfolgId, id)).toBeNull();
    expect(await softDeleteTask(getDb(), erfolgId, id)).toBe(false);
    // Из demo — видна.
    expect(await getTask(getDb(), demoId, id)).toBeTruthy();
  });
});

describe('tasks — владение (assertEngineerOwnsTask)', () => {
  it('инженер-владелец проходит, чужой инженер — FORBIDDEN, staff — насквозь', () => {
    expect(() =>
      assertEngineerOwnsTask({ role: 'engineer', userId: ENG1 }, { assigneeUserId: ENG1 }),
    ).not.toThrow();
    expect(() =>
      assertEngineerOwnsTask({ role: 'engineer', userId: ENG2 }, { assigneeUserId: ENG1 }),
    ).toThrow(TRPCError);
    expect(() =>
      assertEngineerOwnsTask({ role: 'director', userId: 'x' }, { assigneeUserId: ENG1 }),
    ).not.toThrow();
    expect(() =>
      assertEngineerOwnsTask({ role: 'dispatcher', userId: 'x' }, { assigneeUserId: null }),
    ).not.toThrow();
  });

  it('setTaskDoneCmd: инженер не закроет чужую задачу, но закроет свою; staff — любую', async () => {
    const { id } = await createTask(getDb(), erfolgId, directorId, TZ, {
      title: `${TEST_PREFIX}Для ENG1`,
      date: null,
      time: null,
      notes: null,
      assigneeUserId: ENG1,
      remind: false,
    });

    // Чужой инженер — FORBIDDEN.
    await expect(
      setTaskDoneCmd(ctxFor(erfolgId, ENG2, 'engineer'), id, true),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Владелец — ок.
    await expect(setTaskDoneCmd(ctxFor(erfolgId, ENG1, 'engineer'), id, true)).resolves.toEqual({
      ok: true,
    });
    expect(
      (await listTasks(getDb(), erfolgId, { includeDone: true })).find((x) => x.id === id)?.isDone,
    ).toBe(true);
    // Staff снимает отметку с любой задачи.
    await expect(
      setTaskDoneCmd(ctxFor(erfolgId, directorId, 'director'), id, false),
    ).resolves.toEqual({ ok: true });
  });
});

describe('tasks — валидация исполнителя', () => {
  it('нельзя назначить несуществующего исполнителя (BAD_REQUEST), реального — можно', async () => {
    const ctx = ctxFor(erfolgId, directorId, 'director');
    await expect(
      createTaskCmd(ctx, {
        title: `${TEST_PREFIX}bogus`,
        date: null,
        time: null,
        notes: null,
        assigneeUserId: '00000000-0000-4000-8000-0000000000ff',
        remind: false,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      createTaskCmd(ctx, {
        title: `${TEST_PREFIX}valid`,
        date: null,
        time: null,
        notes: null,
        assigneeUserId: directorId,
        remind: false,
      }),
    ).resolves.toHaveProperty('id');
  });

  it('cross-tenant: нельзя назначить пользователя demo в задаче erfolg', async () => {
    const demoDirectorId = await withTenantTx(getDb(), demoId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`SELECT id FROM users WHERE role='director' LIMIT 1`,
      );
      return (rows as unknown as Array<{ id: string }>)[0]?.id ?? null;
    });
    expect(demoDirectorId).toBeTruthy();
    const ctx = ctxFor(erfolgId, directorId, 'director');
    await expect(
      createTaskCmd(ctx, {
        title: `${TEST_PREFIX}cross-tenant`,
        date: null,
        time: null,
        notes: null,
        assigneeUserId: demoDirectorId!,
        remind: false,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('tasks — напоминания (воркер)', () => {
  it('тик шлёт push получателю, помечает reminded_at, повторно не шлёт', async () => {
    const { id } = await createTask(getDb(), erfolgId, directorId, TZ, {
      title: `${TEST_PREFIX}Напоминание`,
      date: '2031-03-28',
      time: '10:00',
      notes: null,
      assigneeUserId: null, // получатель = автор (директор)
      remind: true,
    });
    // «Перематываем» момент напоминания в прошлое.
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(
        sql`UPDATE tasks SET remind_at = now() - interval '1 minute' WHERE id = ${id}::uuid`,
      ),
    );

    const dueBefore = await listDueTaskReminders(getDb(), erfolgId);
    const row = dueBefore.find((x) => x.id === id);
    expect(row).toBeTruthy();
    expect(row?.recipientUserId).toBe(directorId);
    expect(row?.recipientRole).toBe('director');

    const stats = await processTaskReminderTick();
    expect(stats.sent).toBeGreaterThanOrEqual(1);

    // Помечено — из очереди исчезло.
    expect((await listDueTaskReminders(getDb(), erfolgId)).some((x) => x.id === id)).toBe(false);
    // Повторный тик — без сбоев.
    const stats2 = await processTaskReminderTick();
    expect(stats2.failed).toBe(0);
  });

  it('выполненная задача с датой в напоминания не попадает', async () => {
    const { id } = await createTask(getDb(), erfolgId, directorId, TZ, {
      title: `${TEST_PREFIX}Уже сделана`,
      date: '2031-04-10',
      time: null,
      notes: null,
      assigneeUserId: null,
      remind: true,
    });
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(
        sql`UPDATE tasks SET remind_at = now() - interval '1 minute' WHERE id = ${id}::uuid`,
      ),
    );
    await setTaskDone(getDb(), erfolgId, id, true, directorId);
    expect((await listDueTaskReminders(getDb(), erfolgId)).some((x) => x.id === id)).toBe(false);
  });
});
