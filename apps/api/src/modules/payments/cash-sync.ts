/**
 * Синхронизация оплат по заявкам с кассой (ДДС).
 *
 * Когда менеджер фиксирует оплату по заявке (payments), она автоматически отражается
 * в кассе как доход — без двойного ввода. Логика живёт здесь и вызывается из
 * payments/repository.ts (addPayment/deletePayment) в ТОЙ ЖЕ транзакции.
 *
 * Защита от задвоения: UNIQUE (tenant_id, payment_id) WHERE payment_id IS NOT NULL
 * + ON CONFLICT DO NOTHING — повтор (в т.ч. при ретрае 40001/40P01) не создаёт дубль.
 *
 * Если у tenant нет подходящего денежного счёта — graceful no-op (платёж сохраняется,
 * деньги не теряются; директор увидит и заведёт счёт, бэкфилл подтянет позже).
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { cashAccounts, cashCategories, cashTransactions } from '@erfolg/db';
import type { withTenantTx } from '@erfolg/db';
import { recalcAccountBalanceInTx } from '../cash/repository';
import { orgDayValue } from '../../lib/org-day';
import { logger } from '../../lib/logger';

type Tx = Parameters<Parameters<typeof withTenantTx>[2]>[0];
type PaymentMethod = 'cash' | 'card' | 'bank_transfer';

/** Метод оплаты → тип денежного счёта для фолбэка. */
const METHOD_TO_KIND: Record<PaymentMethod, 'cash' | 'bank' | 'card'> = {
  cash: 'cash',
  card: 'card',
  bank_transfer: 'bank',
};

/**
 * Выбрать счёт для авто-дохода: сперва по default_for_method, затем фолбэк по типу счёта.
 * Возвращает null если активных счетов нет (тогда вызывающий делает no-op).
 */
async function pickAccountForMethod(
  tx: Tx,
  tenantId: string,
  method: PaymentMethod,
): Promise<string | null> {
  const byDefault = await tx
    .select({ id: cashAccounts.id })
    .from(cashAccounts)
    .where(
      and(
        eq(cashAccounts.tenantId, tenantId),
        eq(cashAccounts.defaultForMethod, method),
        eq(cashAccounts.isArchived, false),
        isNull(cashAccounts.deletedAt),
      ),
    )
    .limit(1);
  if (byDefault[0]) return byDefault[0].id;

  const byKind = await tx
    .select({ id: cashAccounts.id })
    .from(cashAccounts)
    .where(
      and(
        eq(cashAccounts.tenantId, tenantId),
        eq(cashAccounts.kind, METHOD_TO_KIND[method]),
        eq(cashAccounts.isArchived, false),
        isNull(cashAccounts.deletedAt),
      ),
    )
    .orderBy(asc(cashAccounts.sortOrder))
    .limit(1);
  return byKind[0]?.id ?? null;
}

/** Системная статья «Оплата по заявкам» (может отсутствовать — тогда categoryId=null). */
async function findTicketPaymentCategory(tx: Tx, tenantId: string): Promise<string | null> {
  const rows = await tx
    .select({ id: cashCategories.id })
    .from(cashCategories)
    .where(
      and(
        eq(cashCategories.tenantId, tenantId),
        eq(cashCategories.systemCode, 'ticket_payment'),
        isNull(cashCategories.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface PaymentForCash {
  id: string;
  ticketId: string;
  invoiceId: string | null;
  amountKopecks: bigint;
  method: PaymentMethod;
  paidAt: Date;
  userId: string | null;
}

/**
 * Создать (идемпотентно) доходную операцию в кассе из оплаты по заявке и пересчитать
 * остаток счёта. Вызывать в открытой tenant-tx после INSERT платежа.
 */
export async function syncCashFromPaymentInTx(
  tx: Tx,
  tenantId: string,
  payment: PaymentForCash,
): Promise<void> {
  const accountId = await pickAccountForMethod(tx, tenantId, payment.method);
  if (!accountId) {
    logger.warn(
      { tenantId, paymentId: payment.id, method: payment.method },
      'cash-sync: нет денежного счёта для метода — доход в кассу не проведён (no-op)',
    );
    return;
  }
  const categoryId = await findTicketPaymentCategory(tx, tenantId);
  // День платежа — в поясе организации: ночной платёж (00:00–03:00 МСК) по UTC
  // датировался вчерашним днём и не попадал в «сегодня» кассового журнала.
  const occurredOn = await orgDayValue(tx, tenantId, payment.paidAt);

  await tx
    .insert(cashTransactions)
    .values({
      tenantId,
      kind: 'income',
      accountId,
      categoryId,
      amountKopecks: payment.amountKopecks,
      occurredOn,
      comment: 'Оплата по заявке',
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
      ticketId: payment.ticketId,
      userId: payment.userId,
      source: 'payment',
    })
    .onConflictDoNothing({
      target: [cashTransactions.tenantId, cashTransactions.paymentId],
      where: sql`payment_id IS NOT NULL AND deleted_at IS NULL`,
    });

  await recalcAccountBalanceInTx(tx, tenantId, accountId);
}

/**
 * Убрать доход из кассы при удалении оплаты (soft-delete cash-операции по payment_id
 * + пересчёт остатка). Вызывать в открытой tenant-tx.
 */
export async function removeCashForPaymentInTx(
  tx: Tx,
  tenantId: string,
  paymentId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: cashTransactions.id, accountId: cashTransactions.accountId })
    .from(cashTransactions)
    .where(
      and(
        eq(cashTransactions.tenantId, tenantId),
        eq(cashTransactions.paymentId, paymentId),
        isNull(cashTransactions.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return;
  await tx
    .update(cashTransactions)
    .set({ deletedAt: new Date() })
    .where(eq(cashTransactions.id, row.id));
  await recalcAccountBalanceInTx(tx, tenantId, row.accountId);
}
