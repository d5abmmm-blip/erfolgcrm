/**
 * Service слой ticket_kp_versions. Все мутации с writeAudit.
 *
 * Инварианты:
 *   • ticketId валидируется в текущем тенанте (FK не уважает RLS — проверка обязательна);
 *   • approve — атомарный (approved-версия одна, прочие демотируются);
 *   • approved-версию нельзя архивировать и нельзя редактировать суммы
 *     (источник согласованной оценки).
 */
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { tickets, withTenantTx, type Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  approveKp,
  archiveKp,
  createKp,
  getKpById,
  latestByTicket,
  listByTicket,
  updateKp,
  type KpVersionDto,
  type UpdateKpPatch,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

async function ticketExistsInTenant(db: Db, tenantId: string, ticketId: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);
    return rows.length > 0;
  });
}

export async function listByTicketQuery(
  db: Db,
  tenant: ResolvedTenant,
  ticketId: string,
): Promise<KpVersionDto[]> {
  return listByTicket(db, tenant.id, ticketId);
}

export async function latestByTicketQuery(
  db: Db,
  tenant: ResolvedTenant,
  ticketId: string,
): Promise<KpVersionDto | null> {
  return latestByTicket(db, tenant.id, ticketId);
}

export interface CreateKpCmdInput {
  ticketId: string;
  status?: 'draft' | 'sent';
  worksAmountKopecks: bigint;
  partsAmountKopecks: bigint;
  description: string;
}

export async function createKpCmd(
  ctx: CmdCtx,
  input: CreateKpCmdInput,
): Promise<{ id: string; version: number }> {
  const ok = await ticketExistsInTenant(ctx.db, ctx.tenant.id, input.ticketId);
  if (!ok) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Заявка не найдена' });

  const result = await createKp(ctx.db, ctx.tenant.id, {
    ...input,
    createdByUserId: ctx.session.userId,
  });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'ticket_kp_version',
    entityId: result.id,
    after: {
      ticketId: input.ticketId,
      version: result.version,
      status: input.status ?? 'draft',
    },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function updateKpCmd(
  ctx: CmdCtx,
  id: string,
  patch: UpdateKpPatch,
): Promise<KpVersionDto> {
  const current = await getKpById(ctx.db, ctx.tenant.id, id);
  if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Версия КП не найдена' });

  // Утверждённая версия — read-only по суммам/тексту; статус меняется только через approve-демоушен.
  if (current.status === 'approved') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Утверждённая версия КП не редактируется. Создайте новую версию.',
    });
  }
  // approve — только через отдельную процедуру (атомарная семантика).
  if (patch.status === 'approved') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Используйте процедуру approve для утверждения версии',
    });
  }

  const updated = await updateKp(ctx.db, ctx.tenant.id, id, patch);
  if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Версия КП не найдена' });

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket_kp_version',
    entityId: id,
    after: {
      patchKeys: Object.keys(patch),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return updated;
}

export async function approveKpCmd(ctx: CmdCtx, id: string): Promise<KpVersionDto> {
  const approved = await approveKp(ctx.db, ctx.tenant.id, id);
  if (!approved) throw new TRPCError({ code: 'NOT_FOUND', message: 'Версия КП не найдена' });

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket_kp_version',
    entityId: id,
    after: {
      status: 'approved',
      version: approved.version,
      totalAmountKopecks: approved.totalAmountKopecks,
    },
    context: { ticketId: approved.ticketId },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return approved;
}

export async function archiveKpCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  const current = await getKpById(ctx.db, ctx.tenant.id, id);
  if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Версия КП не найдена' });
  if (current.status === 'approved') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Нельзя удалить утверждённую версию КП. Сначала создайте новую версию или отклоните текущую.',
    });
  }
  const ok = await archiveKp(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Версия КП не найдена' });

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'ticket_kp_version',
    entityId: id,
    after: { archived: true, version: current.version },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}
