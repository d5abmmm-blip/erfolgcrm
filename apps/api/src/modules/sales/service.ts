/**
 * Service продаж. Query — тонкие обёртки; Cmd — пишут audit и оборачивают
 * бизнес-ошибки repository в TRPCError (паттерн cash/trade-in service).
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import * as repo from './repository';

function toTrpc(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof Error) return new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Неизвестная ошибка' });
}

export function listSalesQuery(db: Db, tenant: ResolvedTenant, opts: repo.ListOpts) {
  return repo.listSales(db, tenant.id, opts);
}

export function getSaleQuery(db: Db, tenant: ResolvedTenant, id: string) {
  return repo.getSale(db, tenant.id, id);
}

export async function createSaleCmd(
  ctx: CmdCtx,
  input: Omit<repo.CreateSaleInput, 'createdBy'>,
) {
  let result;
  try {
    result = await repo.createSale(ctx.db, ctx.tenant.id, {
      ...input,
      createdBy: ctx.session.userId,
    });
  } catch (err) {
    throw toTrpc(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'sale',
    entityId: result.id,
    after: { clientId: input.clientId, itemsCount: input.items.length },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function updateSaleCmd(ctx: CmdCtx, id: string, patch: repo.UpdateSaleInput) {
  let ok;
  try {
    ok = await repo.updateSale(ctx.db, ctx.tenant.id, id, patch);
  } catch (err) {
    throw toTrpc(err);
  }
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Продажа не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'sale',
    entityId: id,
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

export async function setStatusCmd(ctx: CmdCtx, id: string, status: repo.SaleStatus) {
  const ok = await repo.setSaleStatus(ctx.db, ctx.tenant.id, id, status);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Продажа не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'sale',
    entityId: id,
    after: { status },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

export async function paySaleCmd(
  ctx: CmdCtx,
  id: string,
  input: { accountId: string; paidOn: string },
) {
  let ok;
  try {
    ok = await repo.paySale(ctx.db, ctx.tenant.id, id, {
      accountId: input.accountId,
      paidOn: input.paidOn,
      userId: ctx.session.userId,
    });
  } catch (err) {
    throw toTrpc(err);
  }
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Продажа не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'sale',
    entityId: id,
    after: { paid: true, accountId: input.accountId },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

export async function unpaySaleCmd(ctx: CmdCtx, id: string) {
  const ok = await repo.unpaySale(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Продажа не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'sale',
    entityId: id,
    after: { paid: false },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

export async function deleteSaleCmd(ctx: CmdCtx, id: string) {
  const ok = await repo.deleteSale(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Продажа не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'sale',
    entityId: id,
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}
