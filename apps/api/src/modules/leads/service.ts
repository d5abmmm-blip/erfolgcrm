/**
 * Service слой leads. Все мутации с writeAudit.
 *
 * - score пересчитывается через calculateLeadScore на create/update (на смерженном состоянии).
 * - переходы статусов валидируются стейт-машиной ALLOWED_LEAD_TRANSITIONS
 *   (по образцу tickets/service.ts assertTransitionAllowed).
 * - convertToClient — создаёт клиента и помечает лид won (атомарно в repository).
 */
import { TRPCError } from '@trpc/server';
import { getTenantEncryptionKey, type Db } from '@erfolg/db';
import type { LeadStatus } from '@erfolg/shared';
import { writeAudit } from '../../lib/audit';
import { calculateLeadScore } from './scoring';
import {
  archiveLead,
  convertLeadToClient,
  createLead as repoCreate,
  getLeadById,
  leadFunnelStats,
  listLeads,
  updateLead as repoUpdate,
  type ConvertOpts,
  type CreateLeadInput,
  type FunnelStats,
  type LeadDto,
  type ListOpts,
  type UpdateLeadPatch,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

/** Допустимые переходы стадий воронки. Из won/lost — терминально. В lost — из любой активной. */
const ALLOWED_LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  new: ['contacted', 'lost'],
  contacted: ['proposal', 'lost'],
  proposal: ['negotiation', 'lost'],
  negotiation: ['won', 'lost'],
  won: [],
  lost: [],
};

function assertLeadTransition(from: LeadStatus, to: LeadStatus): void {
  if (from === to) return; // идемпотентность
  if (!ALLOWED_LEAD_TRANSITIONS[from].includes(to)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Нельзя перевести лид из «${from}» в «${to}»`,
    });
  }
}

export async function listLeadsQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: ListOpts,
): Promise<{ items: LeadDto[]; total: number }> {
  return listLeads(db, tenant.id, opts);
}

export async function getLeadQuery(
  db: Db,
  tenant: ResolvedTenant,
  id: string,
): Promise<LeadDto> {
  const row = await getLeadById(db, tenant.id, id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Лид не найден' });
  return row;
}

export async function leadFunnelStatsQuery(
  db: Db,
  tenant: ResolvedTenant,
): Promise<FunnelStats> {
  return leadFunnelStats(db, tenant.id);
}

export async function createLeadCmd(
  ctx: CmdCtx,
  input: Omit<CreateLeadInput, 'score'>,
): Promise<{ id: string }> {
  const score = calculateLeadScore({
    estimatedValue: input.estimatedValue ?? 0,
    email: input.email,
    source: input.source ?? 'other',
    status: input.status ?? 'new',
    updatedAt: new Date(),
  });
  const result = await repoCreate(ctx.db, ctx.tenant.id, { ...input, score });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'lead',
    entityId: result.id,
    after: { name: input.name, source: input.source ?? 'other', status: input.status ?? 'new' },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function updateLeadCmd(
  ctx: CmdCtx,
  id: string,
  patch: Omit<UpdateLeadPatch, 'score'>,
): Promise<LeadDto> {
  const current = await getLeadById(ctx.db, ctx.tenant.id, id);
  if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Лид не найден' });

  if (patch.status !== undefined) {
    assertLeadTransition(current.status, patch.status);
  }

  // Пересчёт score на смерженном состоянии.
  const score = calculateLeadScore({
    estimatedValue: patch.estimatedValue ?? current.estimatedValue,
    email: patch.email ?? current.email,
    source: patch.source ?? current.source,
    status: patch.status ?? current.status,
    updatedAt: new Date(),
  });

  const updated = await repoUpdate(ctx.db, ctx.tenant.id, id, { ...patch, score });
  if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Лид не найден' });

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'lead',
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

export async function archiveLeadCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  const ok = await archiveLead(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Лид не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'lead',
    entityId: id,
    after: { archived: true },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

export async function convertLeadToClientCmd(
  ctx: CmdCtx,
  input: { leadId: string } & ConvertOpts,
): Promise<{ clientId: string }> {
  const lead = await getLeadById(ctx.db, ctx.tenant.id, input.leadId);
  if (!lead) throw new TRPCError({ code: 'NOT_FOUND', message: 'Лид не найден' });
  if (lead.status === 'lost') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Нельзя конвертировать проигранный лид' });
  }
  if (lead.convertedClientId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Лид уже сконвертирован в клиента' });
  }

  // Тот же инвариант, что в clients/service.ts («Для физлица обязательно ФИО»).
  // Дублируем сознательно: звать createClientCmd отсюда нельзя, иначе развалится
  // единая транзакция «создать клиента + пометить лид» и повторный клик заведёт
  // второго клиента.
  if (input.clientType === 'individual' && !input.individualFullName?.trim()) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Для физлица обязательно ФИО',
    });
  }

  const key = getTenantEncryptionKey({ id: ctx.tenant.id, kmsKeyId: null });
  const result = await convertLeadToClient(ctx.db, ctx.tenant.id, key, input.leadId, {
    clientType: input.clientType,
    inn: input.inn,
    kpp: input.kpp,
    individualFullName: input.individualFullName,
  });
  if (!result) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Не удалось сконвертировать лид' });
  }

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'client',
    entityId: result.clientId,
    after: { fromLeadId: input.leadId, clientType: input.clientType },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'lead',
    entityId: input.leadId,
    after: { convertedClientId: result.clientId, status: 'won' },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}
