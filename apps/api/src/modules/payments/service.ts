/**
 * Service слой payments.
 * addPayment / deletePayment пересчитывают work_orders.paid_amount_kopecks в той же транзакции.
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  addPayment as repoAdd,
  deletePayment as repoDelete,
  getPaidTotal as repoGetTotal,
  listByTicket as repoList,
  ticketStatusInTenant,
  type AddPaymentInput,
  type PaymentDto,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

export async function listByTicketQuery(
  db: Db,
  tenant: ResolvedTenant,
  ticketId: string,
): Promise<PaymentDto[]> {
  return repoList(db, tenant.id, ticketId);
}

export async function getTotalsQuery(db: Db, tenant: ResolvedTenant, ticketId: string) {
  return repoGetTotal(db, tenant.id, ticketId);
}

export async function addPaymentCmd(
  ctx: CmdCtx,
  input: Omit<AddPaymentInput, 'userId'>,
): Promise<{ id: string; paidTotalKopecks: string; invoicePaidKopecks: string | null }> {
  const ticketStatus = await ticketStatusInTenant(ctx.db, ctx.tenant.id, input.ticketId);
  if (ticketStatus === null) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Заявка не найдена в этом тенанте' });
  }
  // Отмена — это «работы не будет». Принятый по такой заявке платёж встаёт в кассу и
  // в дебиторку, и потом его ищут руками. Отменённый СЧЁТ был закрыт от оплаты и
  // раньше (addPayment смотрит его статус) — здесь закрывается сама заявка.
  if (ticketStatus === 'cancelled') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Заявка отменена — платёж по ней принять нельзя. Сначала переоткройте заявку.',
    });
  }
  let result;
  try {
    result = await repoAdd(ctx.db, ctx.tenant.id, {
      ...input,
      userId: ctx.session.userId,
    });
  } catch (err) {
    if (err instanceof Error) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
    }
    throw err;
  }
  // Для skipped (идемпотентный повтор) audit не пишем — дубль не приносит новой информации.
  if (!result.skipped) {
    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'create',
      entityType: 'payment',
      entityId: result.id,
      after: {
        ticketId: input.ticketId,
        invoiceId: input.invoiceId ?? null,
        amountKopecks: input.amountKopecks.toString(),
        method: input.method,
      },
      ip: ctx.audit.ip ?? null,
      userAgent: ctx.audit.userAgent ?? null,
    });
  }
  return {
    id: result.id,
    paidTotalKopecks: result.paidTotalKopecks,
    invoicePaidKopecks: result.invoicePaidKopecks,
  };
}

export async function deletePaymentCmd(
  ctx: CmdCtx,
  paymentId: string,
): Promise<{ paidTotalKopecks: string; invoicePaidKopecks: string | null }> {
  const result = await repoDelete(ctx.db, ctx.tenant.id, paymentId);
  if (!result) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Платёж не найден' });
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'payment',
    entityId: paymentId,
    after: {
      paidTotalKopecks: result.paidTotalKopecks,
      invoicePaidKopecks: result.invoicePaidKopecks,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}
