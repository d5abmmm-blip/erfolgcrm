/**
 * Service слой work-orders.
 *
 * Бизнес-инвариант: total_amount_kopecks материализован — пересчитывается в
 * recalcTotals() (см. repository.ts) при каждом upsert/delete строки.
 *
 * В audit logs не пишем «name» / «comment» строки и diagnosis/repairDescription —
 * там может быть PII или жалобы пациента (см. logger redact).
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import type { VatRate } from '@erfolg/shared';
import { writeAudit } from '../../lib/audit';
import {
  deleteLine as repoDeleteLine,
  getOrCreateWorkOrder as repoGetOrCreate,
  getWorkOrderByTicket as repoGetByTicket,
  updateWorkOrderHeader as repoUpdateHeader,
  upsertLine as repoUpsertLine,
  workOrderIdForTicket,
  type UpdateHeaderInput,
  type UpsertLineInput,
  type WorkOrderDto,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

export async function getWorkOrderByTicketQuery(
  db: Db,
  tenant: ResolvedTenant,
  ticketId: string,
): Promise<WorkOrderDto | null> {
  return repoGetByTicket(db, tenant.id, ticketId);
}

export async function ensureWorkOrderCmd(
  ctx: CmdCtx,
  ticketId: string,
): Promise<WorkOrderDto> {
  const result = await repoGetOrCreate(ctx.db, ctx.tenant.id, ticketId);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'work_order',
    entityId: result.id,
    after: { ticketId, orderNumber: result.orderNumber },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

export interface UpsertLineCmdInput extends UpsertLineInput {
  ticketId: string;
  lineId?: string | null;
}

async function resolveWorkOrderForTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<string> {
  const id = await workOrderIdForTicket(db, tenantId, ticketId);
  if (!id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Наряд для этой заявки ещё не создан — сначала вызовите ensure',
    });
  }
  return id;
}

export async function upsertLineCmd(
  ctx: CmdCtx,
  input: UpsertLineCmdInput,
): Promise<{ id: string; workOrderId: string }> {
  const workOrderId = await resolveWorkOrderForTicket(ctx.db, ctx.tenant.id, input.ticketId);
  const result = await repoUpsertLine(
    ctx.db,
    ctx.tenant.id,
    workOrderId,
    input.lineId ?? null,
    {
      lineType: input.lineType,
      name: input.name,
      unit: input.unit,
      quantity: input.quantity,
      unitPriceKopecks: input.unitPriceKopecks,
      engineerId: input.engineerId ?? null,
      comment: input.comment ?? null,
      orderIdx: input.orderIdx,
    },
  );
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: input.lineId ? 'update' : 'create',
    entityType: 'work_order_line',
    entityId: result.id,
    after: {
      workOrderId,
      lineType: input.lineType,
      quantity: input.quantity,
      unitPriceKopecks: input.unitPriceKopecks.toString(),
      hasComment: Boolean(input.comment),
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { id: result.id, workOrderId };
}

export async function deleteLineCmd(
  ctx: CmdCtx,
  ticketId: string,
  lineId: string,
): Promise<void> {
  const workOrderId = await resolveWorkOrderForTicket(ctx.db, ctx.tenant.id, ticketId);
  await repoDeleteLine(ctx.db, ctx.tenant.id, workOrderId, lineId);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'work_order_line',
    entityId: lineId,
    after: { workOrderId },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}

export async function updateHeaderCmd(
  ctx: CmdCtx,
  ticketId: string,
  patch: UpdateHeaderInput,
): Promise<void> {
  const workOrderId = await resolveWorkOrderForTicket(ctx.db, ctx.tenant.id, ticketId);
  await repoUpdateHeader(ctx.db, ctx.tenant.id, workOrderId, patch);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'work_order',
    entityId: workOrderId,
    after: {
      patchKeys: Object.keys(patch),
      vatRateChanged: patch.vatRate !== undefined,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}

export async function setVatRateCmd(
  ctx: CmdCtx,
  ticketId: string,
  vatRate: VatRate,
): Promise<void> {
  const workOrderId = await resolveWorkOrderForTicket(ctx.db, ctx.tenant.id, ticketId);
  await repoUpdateHeader(ctx.db, ctx.tenant.id, workOrderId, { vatRate });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'work_order',
    entityId: workOrderId,
    after: { vatRate },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}
