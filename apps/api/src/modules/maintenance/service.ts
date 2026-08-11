/**
 * Service слой maintenance: планы и факты ТО.
 * Все мутации с writeAudit. recordPerformed дополнительно двигает next_due_at у графика.
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  assetExists,
  createSchedule as repoCreateSchedule,
  listLog as repoListLog,
  listSchedules as repoListSchedules,
  recordPerformed as repoRecordPerformed,
  scheduleResponsible,
  updateSchedule as repoUpdateSchedule,
  type CreateScheduleInput,
  type MaintenanceLogDto,
  type MaintenanceScheduleDto,
  type RecordPerformedInput,
  type ScheduleFilter,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

export async function listSchedulesQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: { filter?: ScheduleFilter; assetId?: string },
): Promise<MaintenanceScheduleDto[]> {
  return repoListSchedules(db, tenant.id, opts);
}

export async function listLogQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: { assetId?: string; from?: Date; to?: Date; limit?: number },
): Promise<MaintenanceLogDto[]> {
  return repoListLog(db, tenant.id, opts);
}

export async function createScheduleCmd(
  ctx: CmdCtx,
  input: CreateScheduleInput,
): Promise<{ id: string }> {
  if (!(await assetExists(ctx.db, ctx.tenant.id, input.assetId))) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Техника не найдена в этом тенанте',
    });
  }
  const result = await repoCreateSchedule(ctx.db, ctx.tenant.id, input);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'maintenance_schedule',
    entityId: result.id,
    after: { assetId: input.assetId, intervalDays: input.intervalDays, kind: input.kind },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

export async function updateScheduleCmd(
  ctx: CmdCtx,
  scheduleId: string,
  patch: Parameters<typeof repoUpdateSchedule>[3],
): Promise<void> {
  await repoUpdateSchedule(ctx.db, ctx.tenant.id, scheduleId, patch);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'maintenance_schedule',
    entityId: scheduleId,
    after: { patchKeys: Object.keys(patch) },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}

export async function recordPerformedCmd(
  ctx: CmdCtx,
  input: Omit<RecordPerformedInput, 'performedByUserId'>,
): Promise<{ id: string }> {
  if (!(await assetExists(ctx.db, ctx.tenant.id, input.assetId))) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Техника не найдена в этом тенанте',
    });
  }
  // Решение владельца 2026-08-11 («ограничить»): инженер отмечает ТО только по
  // графику, где он ответственный. Разовые отметки без графика и чужие графики —
  // менеджер/директор. Раньше проверок не было вовсе: любой инженер закрывал
  // любой график (и двигал его next_due_at).
  if (ctx.session.role === 'engineer') {
    const denied = new TRPCError({
      code: 'FORBIDDEN',
      message: 'Отметить ТО может ответственный по графику, менеджер или директор',
    });
    if (!input.scheduleId) throw denied;
    const schedule = await scheduleResponsible(ctx.db, ctx.tenant.id, input.scheduleId);
    if (!schedule || schedule.responsibleUserId !== ctx.session.userId) throw denied;
  }
  const result = await repoRecordPerformed(ctx.db, ctx.tenant.id, {
    ...input,
    performedByUserId: ctx.session.userId,
  });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'maintenance_log',
    entityId: result.id,
    after: {
      assetId: input.assetId,
      scheduleId: input.scheduleId ?? null,
      ticketId: input.ticketId ?? null,
      hasNotes: Boolean(input.notes),
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}
