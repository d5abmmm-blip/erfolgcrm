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
import { bigint, check, integer, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
