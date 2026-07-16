/**
 * Service тендеров. Query — тонкие обёртки; Cmd — пишут audit и оборачивают
 * бизнес-ошибки repository в TRPCError (паттерн sales/cash service).
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

export function listTendersQuery(db: Db, tenant: ResolvedTenant, opts: repo.ListOpts) {
  return repo.listTenders(db, tenant.id, opts);
}

export function getTenderQuery(db: Db, tenant: ResolvedTenant, id: string) {
  return repo.getTender(db, tenant.id, id);
}

export function tendersSummaryQuery(db: Db, tenant: ResolvedTenant, period: repo.TendersPeriod) {
  return repo.tendersSummary(db, tenant.id, period);
}

export async function createTenderCmd(
  ctx: CmdCtx,
  input: Omit<repo.CreateTenderInput, 'createdBy'>,
) {
  let result;
  try {
    result = await repo.createTender(ctx.db, ctx.tenant.id, {
      ...input,
      createdBy: ctx.session.userId,
    });
  } catch (err) {
    throw toTrpc(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'tender',
    entityId: result.id,
    after: {
      contractNumber: input.contractNumber,
      amountKopecks: input.amountKopecks.toString(),
    },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function updateTenderCmd(ctx: CmdCtx, id: string, patch: repo.UpdateTenderPatch) {
  let ok;
  try {
    ok = await repo.updateTender(ctx.db, ctx.tenant.id, id, patch);
  } catch (err) {
    throw toTrpc(err);
  }
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Тендер не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'tender',
    entityId: id,
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

export async function setStatusCmd(ctx: CmdCtx, id: string, status: repo.TenderStatus) {
  const ok = await repo.setTenderStatus(ctx.db, ctx.tenant.id, id, status);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Тендер не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'tender',
    entityId: id,
    after: { status },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

export async function deleteTenderCmd(ctx: CmdCtx, id: string) {
  const ok = await repo.deleteTender(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Тендер не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'tender',
    entityId: id,
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

export async function addPaymentCmd(ctx: CmdCtx, input: repo.AddPaymentInput) {
  let result;
  try {
    result = await repo.addTenderPayment(ctx.db, ctx.tenant.id, input);
  } catch (err) {
    throw toTrpc(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'tender',
    entityId: input.tenderId,
    after: { payment: input.amountKopecks.toString(), paidOn: input.paidOn },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function deletePaymentCmd(ctx: CmdCtx, tenderId: string, paymentId: string) {
  const ok = await repo.deleteTenderPayment(ctx.db, ctx.tenant.id, paymentId);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Платёж не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'tender',
    entityId: tenderId,
    after: { paymentDeleted: paymentId },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}
