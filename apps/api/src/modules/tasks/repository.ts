/**
 * Задачи менеджеров (таск-лист) — слой данных.
 *
 * Задача = дело фирмы с необязательной датой и исполнителем + состояние «сделано».
 * Инженер видит назначенные ему задачи (listMyTasks) и отмечает выполненными.
 * Задачи с датой попадают в календарь; напоминания шлёт воркер task-reminder.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { tasks, users, withTenantTx, type Db } from '@erfolg/db';

export interface TaskDto {
  id: string;
  title: string;
  notes: string | null;
  /** YYYY-MM-DD или null (задача без даты). */
  dueDate: string | null;
  /** HH:MM или null. */
  dueTime: string | null;
  assigneeUserId: string | null;
  /** ФИО исполнителя (join users) — null если без исполнителя. */
  assigneeName: string | null;
  isDone: boolean;
  doneAt: Date | null;
  /** Запрошено ли напоминание (для отрисовки/редактирования). */
  remind: boolean;
  createdByUserId: string | null;
}

export interface TaskInput {
  title: string;
  /** YYYY-MM-DD или null. */
  date: string | null;
  /** HH:MM или null. */
  time: string | null;
  notes: string | null;
  assigneeUserId: string | null;
  /** Прислать push-напоминание накануне даты в 09:00 (пояс организации). */
  remind: boolean;
}

const dateStr = (col: unknown) => sql<string | null>`to_char(${col}, 'YYYY-MM-DD')`;
const timeStr = (col: unknown) => sql<string | null>`to_char(${col}, 'HH24:MI')`;

/**
 * Момент напоминания: накануне даты в 09:00 пояса организации.
 * Если момент уже в прошлом (или даты нет) — NULL: задним числом не напоминаем.
 */
function remindAtExpr(date: string, timezone: string) {
  return sql`case
    when ((${date}::date - 1) + time '09:00') at time zone ${timezone} > now()
    then ((${date}::date - 1) + time '09:00') at time zone ${timezone}
    else null
  end`;
}

const SELECT_FIELDS = {
  id: tasks.id,
  title: tasks.title,
  notes: tasks.notes,
  dueDate: dateStr(tasks.dueDate),
  dueTime: timeStr(tasks.dueTime),
  assigneeUserId: tasks.assigneeUserId,
  assigneeName: users.fullName,
  isDone: tasks.isDone,
  doneAt: tasks.doneAt,
  remind: sql<boolean>`(${tasks.remindAt} is not null or ${tasks.remindedAt} is not null)`,
  createdByUserId: tasks.createdByUserId,
};

/** Все задачи tenant'а. Открытые сверху, затем по дате (без даты — вниз), новые выше. */
export async function listTasks(
  db: Db,
  tenantId: string,
  opts: { includeDone?: boolean } = {},
): Promise<TaskDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters = [isNull(tasks.deletedAt)];
    if (!opts.includeDone) filters.push(eq(tasks.isDone, false));
    return tx
      .select(SELECT_FIELDS)
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assigneeUserId))
      .where(and(...filters))
      .orderBy(asc(tasks.isDone), sql`${tasks.dueDate} asc nulls last`, desc(tasks.createdAt));
  });
}

/** Задачи, назначенные конкретному исполнителю (для мобилки инженера). */
export async function listMyTasks(
  db: Db,
  tenantId: string,
  assigneeUserId: string,
  opts: { includeDone?: boolean } = {},
): Promise<TaskDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters = [isNull(tasks.deletedAt), eq(tasks.assigneeUserId, assigneeUserId)];
    if (!opts.includeDone) filters.push(eq(tasks.isDone, false));
    return tx
      .select(SELECT_FIELDS)
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assigneeUserId))
      .where(and(...filters))
      .orderBy(asc(tasks.isDone), sql`${tasks.dueDate} asc nulls last`, desc(tasks.createdAt));
  });
}

export interface TaskOwnershipRow {
  id: string;
  title: string;
  assigneeUserId: string | null;
  isDone: boolean;
}

/** Задача для проверок владения / before-состояния (без join). */
export async function getTask(
  db: Db,
  tenantId: string,
  id: string,
): Promise<TaskOwnershipRow | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        assigneeUserId: tasks.assigneeUserId,
        isDone: tasks.isDone,
      })
      .from(tasks)
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Роль пользователя (для решения «слать ли push инженеру»). */
export async function getUserRole(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<'director' | 'dispatcher' | 'engineer' | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ role: users.role })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    return rows[0]?.role ?? null;
  });
}

export async function createTask(
  db: Db,
  tenantId: string,
  createdByUserId: string | null,
  timezone: string,
  input: TaskInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(tasks)
      .values({
        tenantId,
        title: input.title,
        notes: input.notes,
        dueDate: input.date,
        dueTime: input.time,
        assigneeUserId: input.assigneeUserId,
        createdByUserId,
        remindAt: input.remind && input.date ? remindAtExpr(input.date, timezone) : null,
      })
      .returning({ id: tasks.id });
    const row = rows[0];
    if (!row) throw new Error('createTask: nothing returned');
    return row;
  });
}

export async function updateTask(
  db: Db,
  tenantId: string,
  id: string,
  timezone: string,
  input: TaskInput,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({
        title: input.title,
        notes: input.notes,
        dueDate: input.date,
        dueTime: input.time,
        assigneeUserId: input.assigneeUserId,
        // Перенесли дату или передумали — напоминание пересчитывается,
        // отметка «отправлено» сбрасывается (напомним о новой дате заново).
        remindAt: input.remind && input.date ? remindAtExpr(input.date, timezone) : null,
        remindedAt: null,
      })
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id });
    return rows.length > 0;
  });
}

export async function setTaskDone(
  db: Db,
  tenantId: string,
  id: string,
  isDone: boolean,
  doneByUserId: string | null,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({
        isDone,
        doneAt: isDone ? new Date() : null,
        doneByUserId: isDone ? doneByUserId : null,
      })
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id });
    return rows.length > 0;
  });
}

export async function softDeleteTask(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id });
    return rows.length > 0;
  });
}

/* ───────────── Для воркера напоминаний ───────────── */

export interface DueTaskReminderRow {
  id: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
  /** Кому напомнить: исполнитель, иначе автор задачи. */
  recipientUserId: string | null;
  /** Роль получателя — задаёт ссылку в push (инженеру мобилка, остальным календарь). */
  recipientRole: 'director' | 'dispatcher' | 'engineer' | null;
}

/** Задачи, по которым пора отправить push (remind_at наступил, ещё не слали, не выполнены). */
export async function listDueTaskReminders(
  db: Db,
  tenantId: string,
): Promise<DueTaskReminderRow[]> {
  const recipient = sql`coalesce(${tasks.assigneeUserId}, ${tasks.createdByUserId})`;
  return withTenantTx(db, tenantId, (tx) =>
    tx
      .select({
        id: tasks.id,
        title: tasks.title,
        dueDate: sql<string>`to_char(${tasks.dueDate}, 'YYYY-MM-DD')`,
        dueTime: timeStr(tasks.dueTime),
        recipientUserId: sql<string | null>`${recipient}`,
        recipientRole: sql<'director' | 'dispatcher' | 'engineer' | null>`${users.role}`,
      })
      .from(tasks)
      .leftJoin(users, sql`${users.id} = ${recipient}`)
      .where(
        and(
          sql`${tasks.remindAt} is not null`,
          sql`${tasks.remindAt} <= now()`,
          isNull(tasks.remindedAt),
          isNull(tasks.deletedAt),
          eq(tasks.isDone, false),
        ),
      ),
  );
}

export async function markTaskReminderSent(db: Db, tenantId: string, id: string): Promise<void> {
  await withTenantTx(db, tenantId, (tx) =>
    tx.update(tasks).set({ remindedAt: new Date() }).where(eq(tasks.id, id)),
  );
}
