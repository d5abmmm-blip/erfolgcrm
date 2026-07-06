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
import { logger } from '../../lib/logger';
import {
  createDraft as repoCreateDraft,
  getById as repoGetById,
  invoiceBelongsToTenant,
  listByClient as repoListByClient,
  listByTicket as repoListByTicket,
  listClientOverdueInvoices,
  listForTenant as repoListForTenant,
  receivablesReport,
  type CreateDraftInput,
  type InvoiceDto,
  type ListByClientOpts,
  type ListForTenantOpts,
  type ListForTenantResult,
  type ReceivablesReport,
  softDeleteDraft as repoSoftDeleteDraft,
  transitionToCancelled as repoCancel,
  transitionToIssued as repoIssue,
  updateDraft as repoUpdateDraft,
  type UpdateDraftInput,
} from './repository';
import { getTenantDisplayName, sendInvoiceReminder } from './reminder';
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

/** Отчёт «Дебиторка»: кто должен, разбивка по срокам, сводка. */
export async function receivablesQuery(
  db: Db,
  tenant: ResolvedTenant,
  limit?: number,
): Promise<ReceivablesReport> {
  return receivablesReport(db, tenant.id, limit);
}

export interface SendReminderResult {
  /** Сколько писем реально ушло. */
  sent: number;
  /** Пропущено: у клиента не указан email. */
  skippedNoEmail: number;
  /** Пропущено: почта tenant'а не настроена (транспорт недоступен). */
  notConfigured: number;
  /** Сбой отправки (SMTP отдал ошибку) — в отличие от «почта не настроена». */
  failed: number;
  /** Всего просроченных счетов у клиента (по которым пытались напомнить). */
  total: number;
}

/**
 * Ручное напоминание клиенту: шлёт письмо по каждому его ПРОСРОЧЕННОМУ счёту
 * (по одному письму на счёт — как ночной воркер). Игнорирует недельный cooldown:
 * директор нажал сознательно. Возвращает разбивку исходов для тоста в UI.
 */
export async function sendReminderCmd(
  ctx: CmdCtx,
  clientId: string,
): Promise<SendReminderResult> {
  const overdueInvoices = await listClientOverdueInvoices(ctx.db, ctx.tenant.id, clientId);
  const [firstInvoice] = overdueInvoices;
  if (!firstInvoice) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'У клиента нет просроченных счетов',
    });
  }
  const tenantName = await getTenantDisplayName(ctx.db, ctx.tenant.id);
  const result: SendReminderResult = {
    sent: 0,
    skippedNoEmail: 0,
    notConfigured: 0,
    failed: 0,
    total: overdueInvoices.length,
  };
  for (const invoice of overdueInvoices) {
    const res = await sendInvoiceReminder(
      ctx.db,
      { id: ctx.tenant.id, name: tenantName },
      invoice,
      { dryRun: false },
    );
    if (res.outcome === 'sent') result.sent++;
    else if (res.outcome === 'skipped_no_email') result.skippedNoEmail++;
    else if (res.outcome === 'skipped_mail') result.notConfigured++;
    else result.failed++; // outcome === 'error'
  }
  // Аудит здесь best-effort: письма уже отправлены (необратимо), поэтому сбой записи
  // аудита НЕ должен ронять ответ ошибкой — иначе директор увидит ошибку и кликнет
  // «Напомнить» повторно (ручной путь без cooldown) → клиент получит дубль писем.
  try {
    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'update',
      entityType: 'invoice',
      entityId: firstInvoice.id,
      after: {
        manualReminder: true,
        clientId,
        overdueInvoices: overdueInvoices.length,
        sent: result.sent,
      },
      ip: ctx.audit.ip ?? null,
      userAgent: ctx.audit.userAgent ?? null,
    });
  } catch (err) {
    logger.warn({ err, clientId }, 'sendReminder: audit write failed after emails sent');
  }
  return result;
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
