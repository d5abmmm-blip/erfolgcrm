/**
 * Задачи менеджеров — service-слой. Мутации с writeAudit + push инженеру-исполнителю.
 *
 * RBAC-принцип: staff (директор/диспетчер) распоряжаются задачами полностью;
 * инженер видит только назначенные ему и может лишь отметить «сделано»
 * (assertEngineerOwnsTask). Проверка владения — ВНУТРИ, т.к. engineerProcedure
 * пропускает и staff (см. модуль tickets).
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { enqueuePushToUser } from '../notifications';
import type { CmdCtx } from '../../trpc/helpers';
import type { ResolvedTenant } from '../../lib/tenant';
import type { SessionData } from '../../lib/session';
import {
  createTask,
  getTask,
  getUserRole,
  listMyTasks,
  listTasks,
  setTaskDone,
  softDeleteTask,
  updateTask,
  type TaskDto,
  type TaskInput,
} from './repository';

/** Инженер может трогать только свою задачу; staff/директор проходят насквозь. */
export function assertEngineerOwnsTask(
  session: { role: SessionData['role']; userId: string },
  task: { assigneeUserId: string | null },
): void {
  if (session.role !== 'engineer') return;
  if (task.assigneeUserId !== session.userId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Это не ваша задача' });
  }
}

type Role = 'director' | 'dispatcher' | 'engineer';

/**
 * Проверяет, что исполнитель — реальный пользователь ЭТОГО tenant'а (не удалён,
 * не из чужого tenant'а), и возвращает его роль. Без исполнителя → null.
 * Иначе задачу можно было бы сохранить с «пустым» исполнителем, а напоминание
 * тихо потерялось бы (как в модуле tickets — ensureRefsExist/userBelongsToTenant).
 */
async function resolveAssigneeRole(
  ctx: CmdCtx,
  assigneeUserId: string | null,
): Promise<Role | null> {
  if (!assigneeUserId) return null;
  const role = await getUserRole(ctx.db, ctx.tenant.id, assigneeUserId);
  if (!role) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Исполнитель не найден' });
  return role;
}

/** Push инженеру при назначении задачи (fire-and-forget). Роль проверена вызывающим. */
function pushTaskAssigned(
  ctx: CmdCtx,
  taskId: string,
  title: string,
  engineerUserId: string,
): void {
  enqueuePushToUser({
    tenantId: ctx.tenant.id,
    userId: engineerUserId,
    payload: {
      title: 'Новая задача',
      body: title.slice(0, 140),
      url: '/m/tasks',
      tag: `task-assign-${taskId}`,
      data: { taskId },
    },
  }).catch((err: unknown) => logger.warn({ err, taskId }, 'enqueue task-assign push failed'));
}

export function listTasksQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: { includeDone?: boolean },
): Promise<TaskDto[]> {
  return listTasks(db, tenant.id, opts);
}

export function listMyTasksQuery(
  db: Db,
  tenant: ResolvedTenant,
  assigneeUserId: string,
  opts: { includeDone?: boolean },
): Promise<TaskDto[]> {
  return listMyTasks(db, tenant.id, assigneeUserId, opts);
}

export async function createTaskCmd(ctx: CmdCtx, input: TaskInput): Promise<{ id: string }> {
  // Валидируем исполнителя ДО записи (роль заодно решает, слать ли push инженеру).
  const assigneeRole = await resolveAssigneeRole(ctx, input.assigneeUserId);
  const result = await createTask(
    ctx.db,
    ctx.tenant.id,
    ctx.session.userId,
    ctx.tenant.timezone,
    input,
  );
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'task',
    entityId: result.id,
    after: { title: input.title, dueDate: input.date, assigneeUserId: input.assigneeUserId },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  if (assigneeRole === 'engineer' && input.assigneeUserId) {
    pushTaskAssigned(ctx, result.id, input.title, input.assigneeUserId);
  }
  return result;
}

export async function updateTaskCmd(
  ctx: CmdCtx,
  id: string,
  input: TaskInput,
): Promise<{ ok: true }> {
  const before = await getTask(ctx.db, ctx.tenant.id, id);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Задача не найдена' });
  // Исполнителя проверяем ТОЛЬКО если он сменился на нового (правка чужих полей
  // не должна падать из-за исполнителя, уволенного уже после назначения).
  const assigneeChanged = (input.assigneeUserId ?? null) !== (before.assigneeUserId ?? null);
  const newAssigneeRole = assigneeChanged
    ? await resolveAssigneeRole(ctx, input.assigneeUserId)
    : null;
  const ok = await updateTask(ctx.db, ctx.tenant.id, id, ctx.tenant.timezone, input);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Задача не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'task',
    entityId: id,
    after: { title: input.title, dueDate: input.date, assigneeUserId: input.assigneeUserId },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  // Push только при РЕАЛЬНОЙ смене исполнителя на нового инженера (иначе спам).
  if (assigneeChanged && newAssigneeRole === 'engineer' && input.assigneeUserId) {
    pushTaskAssigned(ctx, id, input.title, input.assigneeUserId);
  }
  return { ok: true };
}

export async function setTaskDoneCmd(
  ctx: CmdCtx,
  id: string,
  isDone: boolean,
): Promise<{ ok: true }> {
  const before = await getTask(ctx.db, ctx.tenant.id, id);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Задача не найдена' });
  assertEngineerOwnsTask(ctx.session, before);
  const ok = await setTaskDone(ctx.db, ctx.tenant.id, id, isDone, ctx.session.userId);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Задача не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'task',
    entityId: id,
    after: { isDone },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

export async function deleteTaskCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  const ok = await softDeleteTask(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Задача не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'task',
    entityId: id,
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}
