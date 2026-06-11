/** Service слой roadmap. Мутации с writeAudit. */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  archiveGoal,
  createGoal as repoCreate,
  listGoals,
  updateGoal as repoUpdate,
  type CreateGoalInput,
  type RoadmapGoalDto,
  type UpdateGoalPatch,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

export async function listGoalsQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: { year?: number },
): Promise<RoadmapGoalDto[]> {
  return listGoals(db, tenant.id, opts);
}

export async function createGoalCmd(ctx: CmdCtx, input: CreateGoalInput): Promise<{ id: string }> {
  const result = await repoCreate(ctx.db, ctx.tenant.id, input);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'roadmap_goal',
    entityId: result.id,
    after: { title: input.title, quarter: input.quarter, year: input.year },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function updateGoalCmd(
  ctx: CmdCtx,
  id: string,
  patch: UpdateGoalPatch,
): Promise<RoadmapGoalDto> {
  const updated = await repoUpdate(ctx.db, ctx.tenant.id, id, patch);
  if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Цель не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'roadmap_goal',
    entityId: id,
    after: { patchKeys: Object.keys(patch) },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return updated;
}

export async function archiveGoalCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  const ok = await archiveGoal(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Цель не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'roadmap_goal',
    entityId: id,
    after: { archived: true },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}
