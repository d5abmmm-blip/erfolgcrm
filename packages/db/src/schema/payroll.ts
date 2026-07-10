/**
 * Этап 9.C — ЗП инженеров.
 *
 * engineer_payout_rules — singleton per tenant (PK = tenant_id).
 * Сам расчёт ЗП за период считается on-the-fly по work_orders, см. payroll/repository.ts.
 *
 * Режимы:
 *   piecework      — % от стоимости работ закрытых WO в периоде
 *   salary_bonus   — фиксированный оклад + % от работ
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
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId, timestamps } from './_shared';

export const payrollModeEnum = pgEnum('payroll_mode', [
  'piecework',
  'salary_bonus',
]);

export const engineerPayoutRules = pgTable(
  'engineer_payout_rules',
  {
    /** PK = tenant_id (один rule на весь СЦ). */
    tenantId: uuid('tenant_id').primaryKey().notNull(),
    mode: payrollModeEnum('mode').notNull().default('piecework'),
    /** Процент сделки (0..100). Для piecework — основной, для salary_bonus — игнор. */
    pieceworkPercent: integer('piecework_percent').notNull().default(30),
    /** Фиксированный оклад в копейках для salary_bonus (для piecework — 0). */
    baseSalaryKopecks: bigint('base_salary_kopecks', { mode: 'bigint' })
      .notNull()
      .default(0n),
    /** % бонуса от работ (для salary_bonus). */
    bonusPercent: integer('bonus_percent').notNull().default(0),
    /**
     * Видят ли инженеры свой заработок в личном кабинете (`/m/earnings` и десктоп
     * `/payroll`). Директор может выключить в «Настройки → Правила расчёта ЗП».
     * По умолчанию true — сохраняем прежнее поведение.
     */
    engineersSeeEarnings: boolean('engineers_see_earnings').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  () => [
    check('engineer_payout_rules_piecework_percent_range', sql`piecework_percent BETWEEN 0 AND 100`),
    check('engineer_payout_rules_bonus_percent_range', sql`bonus_percent BETWEEN 0 AND 100`),
    check('engineer_payout_rules_base_salary_non_negative', sql`base_salary_kopecks >= 0`),
  ],
);

/**
 * Факт выплаты ЗП инженеру за период. Расчёт остаётся on-the-fly, а здесь хранится
 * именно ВЫПЛАЧЕННОЕ (с ручной правкой) + ссылка на расход в кассе.
 *
 * При создании выплаты заводится операция-расход в cash_transactions (статья
 * «Зарплата»), её id кладётся в cash_transaction_id. Правка суммы пересоздаёт расход,
 * удаление выплаты — мягко удаляет расход и пересчитывает остаток счёта.
 *
 * UNIQUE (tenant, engineer, period_start) среди живых — нельзя дважды выплатить
 * одному инженеру за один период (повторно — после отмены прежней выплаты).
 *
 * RLS включается отдельно через 0050_enable_rls_payroll_payouts.sql (setup-rls.ts).
 */
export const payrollPayouts = pgTable(
  'payroll_payouts',
  {
    id: pk(),
    tenantId: tenantId(),
    engineerId: fkUuid('engineer_id'),
    /** Границы периода, за который выплата (period_start уникализирует выплату). */
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    /** Человекочитаемая метка периода («Июнь», «Неделя» и т.п.). */
    periodLabel: varchar('period_label', { length: 40 }).notNull(),
    /** Что система посчитала на момент выплаты — для прозрачности ручной правки. */
    computedKopecks: bigint('computed_kopecks', { mode: 'bigint' }).notNull(),
    /** Сколько реально выплачено (можно отредактировать вручную). > 0. */
    amountKopecks: bigint('amount_kopecks', { mode: 'bigint' }).notNull(),
    paidOn: date('paid_on').notNull(),
    /** Из какого денежного счёта выплачено. */
    accountId: fkUuid('account_id'),
    /** Связанный расход в кассе. NULL только если счёт исчез. */
    cashTransactionId: uuid('cash_transaction_id'),
    comment: text('comment'),
    /** Кто провёл выплату. */
    createdBy: uuid('created_by'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payroll_payouts_engineer_period_uniq')
      .on(t.tenantId, t.engineerId, t.periodStart)
      .where(sql`deleted_at IS NULL`),
    index('payroll_payouts_tenant_period_idx')
      .on(t.tenantId, t.periodStart)
      .where(sql`deleted_at IS NULL`),
    check('payroll_payouts_amount_pos', sql`amount_kopecks > 0`),
    check('payroll_payouts_computed_non_negative', sql`computed_kopecks >= 0`),
  ],
);
