/**
 * Касса / Движение денежных средств (ДДС).
 *
 * Поверх существующих invoices (дебиторка) и payments (оплаты по заявкам) добавляем
 * полноценный учёт денег компании: где они лежат (счета), что пришло/ушло (операции),
 * по каким статьям. Оплаты по заявкам попадают сюда автоматически как доход
 * (см. apps/api/src/modules/payments/cash-sync.ts) — без двойного ввода.
 *
 * Три таблицы:
 *   cash_accounts      — денежные счета-кошельки (Наличные/Расчётный/Карта) с остатком;
 *   cash_categories    — статьи доходов/расходов (Зарплата, Аренда, Оплата по заявкам…);
 *   cash_transactions  — операции: доход / расход / перевод между счетами.
 *
 * Все суммы — копейки (bigint, в DTO → string), как в payments/invoices.
 * balance_kopecks материализован — пересчитывается в cash/repository.ts при изменении
 * операций (полный пересчёт под FOR UPDATE, образец — payments.recalcPaidAmountInTx).
 *
 * RLS включается отдельно через 0047_enable_rls_cash.sql (setup-rls.ts).
 */
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';
import { paymentMethodEnum } from './payments';

/** Тип денежного счёта. cash — наличные, bank — расчётный счёт, card — карта/эквайринг. */
export const cashAccountKindEnum = pgEnum('cash_account_kind', ['cash', 'bank', 'card']);

/** Направление статьи: доход или расход. */
export const cashDirectionEnum = pgEnum('cash_direction', ['income', 'expense']);

/** Тип операции: доход, расход или перевод между своими счетами. */
export const cashTxKindEnum = pgEnum('cash_tx_kind', ['income', 'expense', 'transfer']);

/**
 * Денежные счета (кошельки). Остаток balance_kopecks материализован:
 *   balance = opening_balance + Σ income − Σ expense − Σ(transfer откуда) + Σ(transfer куда)
 * Знак НЕ ограничиваем — перерасход возможен (показываем красным, пересчёт не должен падать).
 */
export const cashAccounts = pgTable(
  'cash_accounts',
  {
    id: pk(),
    tenantId: tenantId(),
    name: varchar('name', { length: 120 }).notNull(),
    kind: cashAccountKindEnum('kind').notNull(),
    /** Стартовый остаток на момент заведения счёта. */
    openingBalanceKopecks: bigint('opening_balance_kopecks', { mode: 'bigint' })
      .notNull()
      .default(0n),
    /** Материализованный текущий остаток. Пересчитывается в cash/repository.ts. */
    balanceKopecks: bigint('balance_kopecks', { mode: 'bigint' }).notNull().default(0n),
    /**
     * Счёт по умолчанию для авто-доходов от оплат по заявкам с данным методом.
     * cash→наличный, card→карта, bank_transfer→расчётный. Уникален среди живых per tenant.
     */
    defaultForMethod: paymentMethodEnum('default_for_method'),
    isArchived: boolean('is_archived').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('cash_accounts_default_method_uniq')
      .on(t.tenantId, t.defaultForMethod)
      .where(sql`default_for_method IS NOT NULL AND deleted_at IS NULL`),
    index('cash_accounts_tenant_idx')
      .on(t.tenantId)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * Статьи доходов/расходов. Системные (is_system) создаются seed'ом и не удаляются из UI;
 * среди них «Оплата по заявкам» (system_code='ticket_payment') — для авто-доходов.
 */
export const cashCategories = pgTable(
  'cash_categories',
  {
    id: pk(),
    tenantId: tenantId(),
    name: varchar('name', { length: 120 }).notNull(),
    direction: cashDirectionEnum('direction').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    /** Код системной статьи (например 'ticket_payment'). Уникален среди живых per tenant. */
    systemCode: varchar('system_code', { length: 40 }),
    isArchived: boolean('is_archived').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('cash_categories_system_code_uniq')
      .on(t.tenantId, t.systemCode)
      .where(sql`system_code IS NOT NULL AND deleted_at IS NULL`),
    index('cash_categories_tenant_direction_idx')
      .on(t.tenantId, t.direction)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * Операции ДДС. kind определяет смысл:
 *   income/expense — categoryId обязателен по смыслу (но допускаем NULL для авто-дохода
 *                    при отсутствии системной статьи), counterAccountId = NULL;
 *   transfer       — accountId (откуда) + counterAccountId (куда), categoryId = NULL.
 * amount_kopecks всегда > 0; направление денег закодировано в kind.
 *
 * payment_id — связь с payments для авто-дохода. UNIQUE среди живых исключает задвоение
 * (см. cash-sync.ts: INSERT ... ON CONFLICT DO NOTHING).
 */
export const cashTransactions = pgTable(
  'cash_transactions',
  {
    id: pk(),
    tenantId: tenantId(),
    kind: cashTxKindEnum('kind').notNull(),
    /** Счёт операции; для перевода — счёт-источник (откуда). RESTRICT. */
    accountId: fkUuid('account_id'),
    /** Для перевода — счёт-получатель (куда). NULL для income/expense. */
    counterAccountId: uuid('counter_account_id'),
    /** Статья дохода/расхода. NULL для перевода. SET NULL при удалении статьи. */
    categoryId: uuid('category_id'),
    amountKopecks: bigint('amount_kopecks', { mode: 'bigint' }).notNull(),
    /** Дата операции (Drizzle date — string 'YYYY-MM-DD'). */
    occurredOn: date('occurred_on').notNull(),
    comment: text('comment'),
    /** Контрагент свободным текстом (поставщик, арендодатель и т.п.). */
    counterparty: varchar('counterparty', { length: 200 }),
    /** Опциональная привязка к клиенту. */
    clientId: uuid('client_id'),
    /** Кто внёс запись. NULL для системных/авто. */
    userId: uuid('user_id'),
    /** Авто-доход: связь с payments (UNIQUE среди живых). */
    paymentId: uuid('payment_id'),
    invoiceId: uuid('invoice_id'),
    ticketId: uuid('ticket_id'),
    /** Источник записи: 'manual' (внёс менеджер) | 'payment' (авто из оплаты по заявке). */
    source: varchar('source', { length: 20 })
      .$type<'manual' | 'payment'>()
      .notNull()
      .default('manual'),
    ...timestamps,
  },
  (t) => [
    // Главная защита от задвоения авто-доходов.
    uniqueIndex('cash_tx_payment_uniq')
      .on(t.tenantId, t.paymentId)
      .where(sql`payment_id IS NOT NULL AND deleted_at IS NULL`),
    index('cash_tx_tenant_occurred_idx')
      .on(t.tenantId, sql`${t.occurredOn} DESC`)
      .where(sql`deleted_at IS NULL`),
    index('cash_tx_tenant_account_idx')
      .on(t.tenantId, t.accountId)
      .where(sql`deleted_at IS NULL`),
    index('cash_tx_tenant_counter_account_idx')
      .on(t.tenantId, t.counterAccountId)
      .where(sql`counter_account_id IS NOT NULL AND deleted_at IS NULL`),
    index('cash_tx_tenant_category_idx')
      .on(t.tenantId, t.categoryId)
      .where(sql`deleted_at IS NULL`),
    check('cash_tx_amount_pos', sql`amount_kopecks > 0`),
    check(
      'cash_tx_transfer_shape',
      sql`(kind = 'transfer' AND counter_account_id IS NOT NULL AND counter_account_id <> account_id AND category_id IS NULL)
          OR (kind <> 'transfer' AND counter_account_id IS NULL)`,
    ),
  ],
);
