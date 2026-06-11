/**
 * Service слой invoices.
 *
 * Все мутации пишут audit. Без PII в payload (notes/cancelReason — да, но это краткие комментарии).
 * Бизнес-инварианты enforced на уровне repository (статусы, idempotency, snapshot).
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import type { VatRate } from '@erfolg/shared';
import { writeAudit } from '../../lib/audit';
import {
  createDraft as repoCreateDraft,
  getById as repoGetById,
  invoiceBelongsToTenant,
  listByClient as repoListByClient,
  listByTicket as repoListByTicket,
  listForTenant as repoListForTenant,
  type CreateDraftInput,
  type InvoiceDto,
  type ListByClientOpts,
  type ListForTenantOpts,
  type ListForTenantResult,
  softDeleteDraft as repoSoftDeleteDraft,
  transitionToCancelled as repoCancel,
  transitionToIssued as repoIssue,
  updateDraft as repoUpdateDraft,
  type UpdateDraftInput,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import { toTRPCError, WorkOrderNotFoundError } from '../../lib/errors';

export async function getByIdQuery(
  db: Db,
  tenant: ResolvedTenant,
  invoiceId: string,
): Promise<InvoiceDto | null> {
  return repoGetById(db, tenant.id, invoiceId);
}

export async function listByTicketQuery(
  db: Db,
  tenant: ResolvedTenant,
  ticketId: string,
): Promise<InvoiceDto[]> {
  return repoListByTicket(db, tenant.id, ticketId);
}

export async function listByClientQuery(
  db: Db,
  tenant: ResolvedTenant,
  clientId: string,
  opts: ListByClientOpts,
): Promise<InvoiceDto[]> {
  return repoListByClient(db, tenant.id, clientId, opts);
}

export async function listForTenantQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: ListForTenantOpts,
): Promise<ListForTenantResult> {
  return repoListForTenant(db, tenant.id, opts);
}

export async function createDraftCmd(
  ctx: CmdCtx,
  input: CreateDraftInput,
): Promise<InvoiceDto> {
  let dto: InvoiceDto;
  try {
    dto = await repoCreateDraft(ctx.db, ctx.tenant.id, input);
  } catch (err) {
    if (err instanceof WorkOrderNotFoundError) throw toTRPCError(err);
    throw err;
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'invoice',
    entityId: dto.id,
    after: {
      invoiceNumber: dto.invoiceNumber,
      workOrderId: dto.workOrderId,
      totalAmountKopecks: dto.totalAmountKopecks,
      status: dto.status,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return dto;
}

export async function issueCmd(
  ctx: CmdCtx,
  invoiceId: string,
  opts: { dueDate?: string },
): Promise<InvoiceDto> {
  const dto = await repoIssue(ctx.db, ctx.tenant.id, invoiceId, opts);
  if (!dto) throw new TRPCError({ code: 'NOT_FOUND', message: 'Счёт не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'invoice',
    entityId: dto.id,
    after: {
      invoiceNumber: dto.invoiceNumber,
      status: dto.status,
      totalAmountKopecks: dto.totalAmountKopecks,
      dueDate: dto.dueDate,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return dto;
}

export async function cancelCmd(
  ctx: CmdCtx,
  invoiceId: string,
  reason: string | null,
): Promise<InvoiceDto> {
  const dto = await repoCancel(ctx.db, ctx.tenant.id, invoiceId, reason);
  if (!dto) throw new TRPCError({ code: 'NOT_FOUND', message: 'Счёт не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'invoice',
    entityId: dto.id,
    after: {
      invoiceNumber: dto.invoiceNumber,
      status: dto.status,
      hasReason: Boolean(reason),
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return dto;
}

export interface UpdateDraftCmdInput extends UpdateDraftInput {
  invoiceId: string;
}

export async function updateDraftCmd(
  ctx: CmdCtx,
  input: UpdateDraftCmdInput,
): Promise<InvoiceDto> {
  const { invoiceId, ...patch } = input;
  const dto = await repoUpdateDraft(ctx.db, ctx.tenant.id, invoiceId, patch);
  if (!dto) throw new TRPCError({ code: 'NOT_FOUND', message: 'Счёт не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'invoice',
    entityId: dto.id,
    after: {
      patchKeys: Object.keys(patch),
      vatRate: dto.vatRate,
      dueDate: dto.dueDate,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return dto;
}

export async function deleteDraftCmd(
  ctx: CmdCtx,
  invoiceId: string,
): Promise<void> {
  if (!(await invoiceBelongsToTenant(ctx.db, ctx.tenant.id, invoiceId))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Счёт не найден' });
  }
  const ok = await repoSoftDeleteDraft(ctx.db, ctx.tenant.id, invoiceId);
  if (!ok) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Удалить можно только черновик. Выставленный счёт нужно отменить.',
    });
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'invoice',
    entityId: invoiceId,
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}

/** Хелпер для UI: тип VAT, default 5% (как в работе ООО Эрфольг). */
export function defaultVatRate(): VatRate {
  return '5';
}
