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
  jsonb,
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

export const payrollModeEnum = pgEnum('payroll_mode', ['piecework', 'salary_bonus']);

/**
 * Тип выплаты ЗП:
 *   advance — аванс (промежуточная выплата в счёт расчёта за период);
 *   final   — окончательный расчёт (основная выплата; сюда попадают все прежние выплаты);
 *   bonus   — премия (отдельное поощрение, НЕ входит в расчёт за период).
 */
export const payrollPayoutKindEnum = pgEnum('payroll_payout_kind', ['advance', 'final', 'bonus']);

export const engineerPayoutRules = pgTable(
  'engineer_payout_rules',
  {
    /** PK = tenant_id (один rule на весь СЦ). */
    tenantId: uuid('tenant_id').primaryKey().notNull(),
    mode: payrollModeEnum('mode').notNull().default('piecework'),
    /** Процент сделки (0..100). Для piecework — основной, для salary_bonus — игнор. */
    pieceworkPercent: integer('piecework_percent').notNull().default(30),
    /** Фиксированный оклад в копейках для salary_bonus (для piecework — 0). */
    baseSalaryKopecks: bigint('base_salary_kopecks', { mode: 'bigint' }).notNull().default(0n),
    /** % бонуса от работ (для salary_bonus). */
    bonusPercent: integer('bonus_percent').notNull().default(0),
    /**
     * Видят ли инженеры свой заработок в личном кабинете (`/m/earnings` и десктоп
     * `/payroll`). Директор может выключить в «Настройки → Правила расчёта ЗП».
     * По умолчанию true — сохраняем прежнее поведение.
     */
    engineersSeeEarnings: boolean('engineers_see_earnings').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  () => [
    check(
      'engineer_payout_rules_piecework_percent_range',
      sql`piecework_percent BETWEEN 0 AND 100`,
    ),
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
 * UNIQUE (tenant, engineer, period_start, kind) среди живых, КРОМЕ премий — за период
 * нельзя дважды провести аванс или окончательный расчёт (повторно — после отмены прежней);
 * премий ('bonus') за период может быть сколько угодно.
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
    /** Тип выплаты: аванс / окончательный расчёт / премия (см. payrollPayoutKindEnum). */
    kind: payrollPayoutKindEnum('kind').notNull().default('final'),
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
    // Один 'advance' и один 'final' на период; премий ('bonus') — сколько угодно.
    uniqueIndex('payroll_payouts_engineer_period_kind_uniq')
      .on(t.tenantId, t.engineerId, t.periodStart, t.kind)
      .where(sql`deleted_at IS NULL AND kind <> 'bonus'`),
    index('payroll_payouts_tenant_period_idx')
      .on(t.tenantId, t.periodStart)
      .where(sql`deleted_at IS NULL`),
    check('payroll_payouts_amount_pos', sql`amount_kopecks > 0`),
    check('payroll_payouts_computed_non_negative', sql`computed_kopecks >= 0`),
  ],
);

/**
 * Строка ручной ведомости — вводится директором вручную. Суммы — ЦЕЛЫЕ КОПЕЙКИ
 * (integer в jsonb; копейки помещаются в Number без потерь точности).
 */
export interface PayrollSheetEntry {
  /** ID пользователя (uuid) либо `manual_<...>` для строки, введённой вручную (свободное имя). */
  employeeId: string;
  employeeName: string;
  /** Оклад (ручной). */
  salaryKopecks: number;
  /** Сделка = работы по закрытым заявкам × %, потом можно поправить руками (для справедливости). */
  pieceworkKopecks: number;
  advanceKopecks: number;
  bonusKopecks: number;
}

/**
 * Ручная ведомость выплат по сотрудникам (перенос из старой CRM).
 *
 * ОТДЕЛЬНЫЙ учётный журнал: директор вручную вбивает оклад/аванс/премию по месяцам.
 * В отличие от payroll_payouts, кассу (ДДС) НЕ трогает — это табель/справка, а не проводка.
 *
 * Одна живая ведомость на (tenant, month). Перезапись существующей — только с причиной
 * (≥10 симв.) и записью diff в audit_logs (402-ФЗ ст.10). Удаление — мягкое (deleted_at),
 * после чего месяц можно завести заново.
 *
 * RLS включается отдельно через 0073_enable_rls_payroll_sheets.sql (setup-rls.ts).
 */
export const payrollSheets = pgTable(
  'payroll_sheets',
  {
    id: pk(),
    tenantId: tenantId(),
    /** Месяц ведомости, формат YYYY-MM. */
    month: varchar('month', { length: 7 }).notNull(),
    /** Строки ведомости (ручной ввод). Суммы — целые копейки. */
    entries: jsonb('entries')
      .notNull()
      .$type<PayrollSheetEntry[]>()
      .default(sql`'[]'::jsonb`),
    /** Кто последним сохранил ведомость. */
    createdBy: uuid('created_by'),
    /**
     * Проведение в кассу: если ведомость проведена, здесь ссылка на расход в
     * cash_transactions (статья «Зарплата»). NULL — не проведена. Сумма/счёт/время
     * проведения — в соседних колонках (для отображения «Проведено: X ₽» и перепроведения).
     */
    cashTransactionId: uuid('cash_transaction_id'),
    postedAmountKopecks: bigint('posted_amount_kopecks', { mode: 'bigint' }),
    postedAccountId: uuid('posted_account_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // Одна живая ведомость на месяц; мягко удалённые не мешают пересоздать месяц.
    uniqueIndex('payroll_sheets_tenant_month_uniq')
      .on(t.tenantId, t.month)
      .where(sql`deleted_at IS NULL`),
    check('payroll_sheets_month_format', sql`month ~ '^[0-9]{4}-[0-9]{2}$'`),
  ],
);

export type PayrollSheet = typeof payrollSheets.$inferSelect;
export type InsertPayrollSheet = typeof payrollSheets.$inferInsert;
