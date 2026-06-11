/**
 * Service слой trade-in. Все мутации с writeAudit.
 *
 * Инварианты:
 *   • status='sold' выставляется только через completeTradeInCmd (атомарный перенос владельца);
 *   • complete требует buyerClientId;
 *   • clientId/buyerClientId/assetId валидируются в текущем тенанте (FK не уважает RLS).
 */
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { assets, clients, withTenantTx, type Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  archiveTradeIn,
  completeTradeIn,
  createTradeIn as repoCreate,
  getTradeInById,
  listTradeIns,
  tradeInStats,
  updateTradeIn as repoUpdate,
  type CreateTradeInInput,
  type ListOpts,
  type TradeInDto,
  type TradeInStats,
  type UpdateTradeInPatch,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

async function clientExistsInTenant(db: Db, tenantId: string, clientId: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .limit(1);
    return rows.length > 0;
  });
}

async function assetExistsInTenant(db: Db, tenantId: string, assetId: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), isNull(assets.deletedAt)))
      .limit(1);
    return rows.length > 0;
  });
}

async function assertRefsInTenant(
  db: Db,
  tenantId: string,
  refs: { clientId?: string | null; buyerClientId?: string | null; assetId?: string | null },
): Promise<void> {
  if (refs.clientId && !(await clientExistsInTenant(db, tenantId, refs.clientId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Клиент (сдавший) не найден' });
  }
  if (refs.buyerClientId && !(await clientExistsInTenant(db, tenantId, refs.buyerClientId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Покупатель не найден' });
  }
  if (refs.assetId && !(await assetExistsInTenant(db, tenantId, refs.assetId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Техника не найдена' });
  }
}

export async function listTradeInsQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: ListOpts,
): Promise<{ items: TradeInDto[]; total: number }> {
  return listTradeIns(db, tenant.id, opts);
}

export async function getTradeInQuery(
  db: Db,
  tenant: ResolvedTenant,
  id: string,
): Promise<TradeInDto> {
  const row = await getTradeInById(db, tenant.id, id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Позиция трейд-ина не найдена' });
  return row;
}

export async function tradeInStatsQuery(db: Db, tenant: ResolvedTenant): Promise<TradeInStats> {
  return tradeInStats(db, tenant.id);
}

export async function createTradeInCmd(
  ctx: CmdCtx,
  input: CreateTradeInInput,
): Promise<{ id: string }> {
  await assertRefsInTenant(ctx.db, ctx.tenant.id, input);
  const result = await repoCreate(ctx.db, ctx.tenant.id, input);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'trade_in_item',
    entityId: result.id,
    after: { name: input.name, receivedAt: input.receivedAt },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function updateTradeInCmd(
  ctx: CmdCtx,
  id: string,
  patch: UpdateTradeInPatch,
): Promise<TradeInDto> {
  const current = await getTradeInById(ctx.db, ctx.tenant.id, id);
  if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Позиция трейд-ина не найдена' });
  if (current.status === 'sold') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Проданная позиция не редактируется',
    });
  }
  await assertRefsInTenant(ctx.db, ctx.tenant.id, patch);

  const updated = await repoUpdate(ctx.db, ctx.tenant.id, id, patch);
  if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Позиция трейд-ина не найдена' });

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'trade_in_item',
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

export async function completeTradeInCmd(
  ctx: CmdCtx,
  input: { id: string; salePriceKopecks?: bigint },
): Promise<TradeInDto> {
  const current = await getTradeInById(ctx.db, ctx.tenant.id, input.id);
  if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Позиция трейд-ина не найдена' });
  if (current.status === 'sold') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Позиция уже продана' });
  }
  if (!current.buyerClientId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Нельзя завершить сделку без покупателя — укажите его в позиции',
    });
  }

  const result = await completeTradeIn(ctx.db, ctx.tenant.id, input.id, {
    salePriceKopecks: input.salePriceKopecks,
    actorUserId: ctx.session.userId,
  });
  if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'Позиция трейд-ина не найдена' });

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'trade_in_item',
    entityId: input.id,
    after: {
      status: 'sold',
      buyerClientId: current.buyerClientId,
      assetTransferred: Boolean(current.assetId),
      ...(input.salePriceKopecks !== undefined
        ? { salePriceKopecks: input.salePriceKopecks.toString() }
        : {}),
    },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function archiveTradeInCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  const ok = await archiveTradeIn(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Позиция трейд-ина не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'trade_in_item',
    entityId: id,
    after: { archived: true },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}
