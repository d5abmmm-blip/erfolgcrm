/**
 * Тендеры (госконтракты) — реестр выигранных контрактов с реальными суммами.
 *
 * По запросу владельца: крупные деньги фирмы идут через тендеры (44-ФЗ), и их
 * реальные цифры нигде в CRM не были видны. Тендер — отдельная сущность
 * (НЕ рамочный договор из contracts: у того нет суммы и другой жизненный цикл).
 *
 * С кассой НЕ связан (осознанно): это реестр сумм и статусов, деньги в кассе
 * учитываются отдельно — никакого автосоздания доходов (защита от задвоения).
 * Оплата приходит частями (по этапам/актам) → отдельная таблица tender_payments;
 * «оплачено X из Y» считается суммой платежей.
 */
import {
  bigint,
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

/** Жизненный цикл: Выигран → Исполняется → Исполнен → Оплачен; Расторгнут — сбоку. */
export const tenderStatusEnum = pgEnum('tender_status', [
  'won',
  'in_progress',
  'fulfilled',
  'paid',
  'cancelled',
]);

export const tenders = pgTable(
  'tenders',
  {
    id: pk(),
    tenantId: tenantId(),

    /** Заказчик — клиент из базы (без FK, как в sales). */
    clientId: fkUuid('client_id'),

    /** № контракта (свободный ввод). */
    contractNumber: varchar('contract_number', { length: 100 }).notNull(),
    /** № закупки/извещения (ЕИС), необязательно. */
    purchaseNumber: varchar('purchase_number', { length: 100 }),

    /** Сумма контракта — «реальная цифра», копейки. */
    amountKopecks: bigint('amount_kopecks', { mode: 'bigint' }).notNull().default(0n),

    contractDate: date('contract_date').notNull(),
    /** Срок исполнения (необязателен). */
    dueDate: date('due_date'),

    status: tenderStatusEnum('status').notNull().default('won'),
    comment: text('comment'),
    createdBy: uuid('created_by'),

    ...timestamps,
  },
  (t) => [
    index('tenders_tenant_date_idx')
      .on(t.tenantId, t.contractDate)
      .where(sql`deleted_at IS NULL`),
    index('tenders_tenant_status_idx')
      .on(t.tenantId, t.status)
      .where(sql`deleted_at IS NULL`),
    index('tenders_tenant_client_idx')
      .on(t.tenantId, t.clientId)
      .where(sql`deleted_at IS NULL`),
    check('tenders_amount_non_negative', sql`amount_kopecks >= 0`),
  ],
);

/** Платежи по тендеру (частями, по этапам/актам). Удаление — жёсткое (как sale_items). */
export const tenderPayments = pgTable(
  'tender_payments',
  {
    id: pk(),
    tenantId: tenantId(),
    tenderId: fkUuid('tender_id'),

    amountKopecks: bigint('amount_kopecks', { mode: 'bigint' }).notNull(),
    paidOn: date('paid_on').notNull(),
    /** Примечание: «аванс», «по акту №2»… */
    note: varchar('note', { length: 300 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tender_payments_tenant_tender_idx').on(t.tenantId, t.tenderId),
    check('tender_payments_amount_positive', sql`amount_kopecks > 0`),
  ],
);
