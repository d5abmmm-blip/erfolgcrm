/**
 * Repository для payments + материализованного work_orders.paid_amount_kopecks.
 *
 * recalcPaidAmount: полный пересчёт SUM(amount_kopecks) по ticket_id под FOR UPDATE
 * на work_orders-строке. Никаких "paid += new" — всегда полный пересчёт.
 *
 * Защита cross-tenant: при addPayment проверяем что ticket_id принадлежит этому tenant'у.
 *
 * Этап 8.B: если payment.invoice_id !== null — также пересчитывается invoices.paid_amount_kopecks
 * и пересчитывается status счёта (issued ↔ partially_paid ↔ paid) в той же транзакции.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  invoices,
  payments,
  tickets,
  withTenantTx,
  workOrders,
  type Db,
} from '@erfolg/db';
import { recomputeStatusFromPaid } from '../invoices/repository';
import { withDbRetry } from '../../lib/db-retry';
import { logger } from '../../lib/logger';

export interface PaymentDto {
  id: string;
  ticketId: string;
  /** Этап 8.B — опциональная привязка к счёту. */
  invoiceId: string | null;
  /** bigint → string копейки */
  amountKopecks: string;
  method: 'cash' | 'card' | 'bank_transfer';
  paidAt: Date;
  comment: string | null;
  userId: string | null;
  createdAt: Date;
}

function toDto(row: {
  id: string;
  ticketId: string;
  invoiceId: string | null;
  amountKopecks: bigint;
  method: 'cash' | 'card' | 'bank_transfer';
  paidAt: Date;
  comment: string | null;
  userId: string | null;
  createdAt: Date;
}): PaymentDto {
  return { ...row, amountKopecks: row.amountKopecks.toString() };
}

export async function listByTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<PaymentDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: payments.id,
        ticketId: payments.ticketId,
        invoiceId: payments.invoiceId,
        amountKopecks: payments.amountKopecks,
        method: payments.method,
        paidAt: payments.paidAt,
        comment: payments.comment,
        userId: payments.userId,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(eq(payments.ticketId, ticketId))
      .orderBy(asc(payments.paidAt), asc(payments.createdAt));
    return rows.map(toDto);
  });
}

export async function listByInvoice(
  db: Db,
  tenantId: string,
  invoiceId: string,
): Promise<PaymentDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: payments.id,
        ticketId: payments.ticketId,
        invoiceId: payments.invoiceId,
        amountKopecks: payments.amountKopecks,
        method: payments.method,
        paidAt: payments.paidAt,
        comment: payments.comment,
        userId: payments.userId,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId))
      .orderBy(asc(payments.paidAt), asc(payments.createdAt));
    return rows.map(toDto);
  });
}

/**
 * Пересчитывает work_orders.paid_amount_kopecks под FOR UPDATE.
 * Безопасно от race conditions: SELECT FOR UPDATE → SUM → UPDATE в одной tx.
 */
async function recalcPaidAmountInTx(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  tenantId: string,
  ticketId: string,
): Promise<bigint> {
  const woRows = await tx
    .select({ id: workOrders.id })
    .from(workOrders)
    .where(eq(workOrders.ticketId, ticketId))
    .for('update')
    .limit(1);
  const woId = woRows[0]?.id;
  if (!woId) {
    // Наряд не создан — нечего пересчитывать (но платёж сохранился). Это
    // редко-встречающийся «marooned» случай: платёж по тикету, у которого ещё
    // нет work_order. Записываем warn — иначе про такие платежи легко забыть.
    logger.warn(
      { tenantId, ticketId },
      'recalcPaidAmountInTx: work_order not found, payment marooned',
    );
    return 0n;
  }
  const sumRows = await tx
    .select({
      sum: sql<string>`COALESCE(SUM(${payments.amountKopecks}), 0)`,
    })
    .from(payments)
    .where(eq(payments.ticketId, ticketId));
  const total = BigInt(sumRows[0]?.sum ?? '0');
  await tx
    .update(workOrders)
    .set({ paidAmountKopecks: total })
    .where(and(eq(workOrders.id, woId), eq(workOrders.tenantId, tenantId)));
  return total;
}

export async function ticketBelongsToTenant(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * Этап 8.B — пересчитать invoices.paid_amount_kopecks по invoice_id под FOR UPDATE.
 * Также вызывает recomputeStatusFromPaid (issued ↔ partially_paid ↔ paid).
 */
async function recalcInvoicePaidInTx(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  invoiceId: string,
): Promise<bigint> {
  // Lock invoice строку
  await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, invoiceId)).for('update').limit(1);
  const sumRows = await tx
    .select({ sum: sql<string>`COALESCE(SUM(${payments.amountKopecks}), 0)` })
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId));
  const total = BigInt(sumRows[0]?.sum ?? '0');
  await tx.update(invoices).set({ paidAmountKopecks: total }).where(eq(invoices.id, invoiceId));
  await recomputeStatusFromPaid(tx, invoiceId);
  return total;
}

/** Проверка: invoice принадлежит тому же тикету (защита от mis-attribution). */
async function invoiceMatchesTicket(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  invoiceId: string,
  ticketId: string,
): Promise<{ ok: boolean; status: string | null }> {
  const rows = await tx
    .select({ id: invoices.id, ticketId: invoices.ticketId, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, status: null };
  if (row.ticketId !== ticketId) return { ok: false, status: row.status };
  return { ok: true, status: row.status };
}

export interface AddPaymentInput {
  ticketId: string;
  /** Этап 8.B — опциональная привязка к счёту. */
  invoiceId?: string | null;
  amountKopecks: bigint;
  method: 'cash' | 'card' | 'bank_transfer';
  paidAt: Date;
  comment?: string | null;
  userId: string | null;
  /**
   * Внешний идентификатор платежа (для идемпотентного импорта из 1С).
   * Если совпадает уникальная тройка (tenant_id, invoice_id, external_payment_id) —
   * INSERT ничего не делает, addPayment вернёт `{ skipped: true }`.
   */
  externalPaymentId?: string | null;
}

export type AddPaymentResult =
  | {
      skipped: false;
      id: string;
      paidTotalKopecks: string;
      invoicePaidKopecks: string | null;
    }
  | {
      skipped: true;
      /** ID существующего платежа, найденного по (tenant_id, invoice_id, external_payment_id). */
      id: string;
      paidTotalKopecks: string;
      invoicePaidKopecks: string | null;
    };

export async function addPayment(
  db: Db,
  tenantId: string,
  input: AddPaymentInput,
): Promise<AddPaymentResult> {
  // PG может выкинуть 40001/40P01 при конкурентных платежах на один счёт
  // (FOR UPDATE на work_orders + invoices). Транзакция должна быть повторена
  // целиком — withDbRetry гарантирует это до 5 попыток с экспоненциальным backoff
  // (25 → 75 → 225 → 675 → 2025 ms ±20% jitter).
  // 3 попытки оказались мало при 3-way contention в нагрузочных тестах.
  return withDbRetry('addPayment', () =>
    withTenantTx(db, tenantId, async (tx) => {
      if (input.invoiceId) {
        const check = await invoiceMatchesTicket(tx, input.invoiceId, input.ticketId);
        if (!check.ok) {
          throw new Error('addPayment: invoice не найден или не принадлежит этому тикету');
        }
        if (check.status === 'cancelled') {
          throw new Error('addPayment: нельзя оплачивать отменённый счёт');
        }
        if (check.status === 'draft') {
          throw new Error('addPayment: нельзя оплатить черновик. Сначала выставьте счёт (issue).');
        }
        // Берём EXCLUSIVE lock на invoice СРАЗУ, до INSERT в payments. Иначе INSERT
        // возьмёт SHARE-lock через FK, потом recompute попробует upgrade до EXCLUSIVE,
        // и при 3+ конкурентных платежах гарантирован lock-upgrade deadlock.
        await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.id, input.invoiceId))
          .for('update')
          .limit(1);
      }

      // Идемпотентность: если задан externalPaymentId, сначала пробуем найти существующую запись.
      // ON CONFLICT (tenant_id, invoice_id, external_payment_id) DO NOTHING + RETURNING вернёт
      // пустую строку при конфликте — тогда читаем существующий id.
      // Note: UNIQUE-индекс по (tenant_id, invoice_id, external_payment_id) WHERE external_payment_id IS NOT NULL
      // создаётся миграцией другого агента. До его наката ON CONFLICT не сработает — но и addPayment
      // с externalPaymentId не вызывается до миграции.
      if (input.externalPaymentId !== undefined && input.externalPaymentId !== null) {
        const existing = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(
            and(
              eq(payments.tenantId, tenantId),
              input.invoiceId
                ? eq(payments.invoiceId, input.invoiceId)
                : isNull(payments.invoiceId),
              eq(payments.externalPaymentId, input.externalPaymentId),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          const total = await recalcPaidAmountInTx(tx, tenantId, input.ticketId);
          const invoicePaid = input.invoiceId
            ? (await recalcInvoicePaidInTx(tx, input.invoiceId)).toString()
            : null;
          return {
            skipped: true,
            id: existing[0]!.id,
            paidTotalKopecks: total.toString(),
            invoicePaidKopecks: invoicePaid,
          };
        }
      }

      const inserted = await tx
        .insert(payments)
        .values({
          tenantId,
          ticketId: input.ticketId,
          invoiceId: input.invoiceId ?? null,
          amountKopecks: input.amountKopecks,
          method: input.method,
          paidAt: input.paidAt,
          comment: input.comment ?? null,
          userId: input.userId,
          externalPaymentId: input.externalPaymentId ?? null,
        })
        .returning({ id: payments.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error('addPayment: insert returned nothing');
      const total = await recalcPaidAmountInTx(tx, tenantId, input.ticketId);
      const invoicePaid = input.invoiceId
        ? (await recalcInvoicePaidInTx(tx, input.invoiceId)).toString()
        : null;
      return {
        skipped: false,
        id,
        paidTotalKopecks: total.toString(),
        invoicePaidKopecks: invoicePaid,
      };
    }),
    5,
  );
}

export async function deletePayment(
  db: Db,
  tenantId: string,
  paymentId: string,
): Promise<{ paidTotalKopecks: string; invoicePaidKopecks: string | null } | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ ticketId: payments.ticketId, invoiceId: payments.invoiceId })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    await tx.delete(payments).where(eq(payments.id, paymentId));
    const total = await recalcPaidAmountInTx(tx, tenantId, row.ticketId);
    const invoicePaid = row.invoiceId
      ? (await recalcInvoicePaidInTx(tx, row.invoiceId)).toString()
      : null;
    return { paidTotalKopecks: total.toString(), invoicePaidKopecks: invoicePaid };
  });
}

/** Получить total paid для тикета (читает из материализованного поля work_orders). */
export async function getPaidTotal(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<{ paidAmountKopecks: string; totalAmountKopecks: string } | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        paidAmountKopecks: workOrders.paidAmountKopecks,
        totalAmountKopecks: workOrders.totalAmountKopecks,
      })
      .from(workOrders)
      .where(eq(workOrders.ticketId, ticketId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      paidAmountKopecks: row.paidAmountKopecks.toString(),
      totalAmountKopecks: row.totalAmountKopecks.toString(),
    };
  });
}

/** Список последних платежей по tenant — для дашборда. */
export async function listRecent(
  db: Db,
  tenantId: string,
  limit = 50,
): Promise<PaymentDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: payments.id,
        ticketId: payments.ticketId,
        invoiceId: payments.invoiceId,
        amountKopecks: payments.amountKopecks,
        method: payments.method,
        paidAt: payments.paidAt,
        comment: payments.comment,
        userId: payments.userId,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .orderBy(desc(payments.paidAt))
      .limit(limit);
    return rows.map(toDto);
  });
}
