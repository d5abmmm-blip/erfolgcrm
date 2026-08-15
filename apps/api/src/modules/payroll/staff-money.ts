/**
 * Вкладка «Деньги» на карточке сотрудника (только директор).
 *
 * Своего расчёта здесь НЕТ: начисление берётся из computePayouts (единственное
 * определение заработка на всю систему), «к выплате» по строке ведомости — из
 * entryToPayKopecks (та же формула, что и проведение ведомости в кассу). Модуль
 * лишь собирает картину по одному человеку: условия оплаты, начислено за месяц,
 * строки ведомостей, история выплат.
 *
 * Уволенному расчёт не показывается вовсе (earnings = null): computePayouts не
 * видит неактивных (оба его запроса режут is_active = false), и вместо честного
 * «расчёт не ведётся» на экране вышло бы «0 ₽» — читается как «ничего не
 * заработал». История выплат и строк ведомостей у уволенного остаётся.
 */
import { sql } from 'drizzle-orm';
import { withTenantTx, type Db, type PayrollSheetEntry } from '@erfolg/db';
import {
  computePayouts,
  getRule,
  hasPersonalRule,
  listPayoutsByEngineer,
  resolveWorkPercent,
  type PayoutBreakdown,
  type PayoutDto,
  type PayrollMode,
  type PayrollRule,
  type UserPayoutConfig,
} from './repository';
import { entryToPayKopecks, listSheets, type PayrollSheetDto } from './sheets';

export interface StaffMoneySheetRow {
  /** Месяц ведомости, YYYY-MM. */
  month: string;
  salaryKopecks: string;
  pieceworkKopecks: string;
  advanceKopecks: string;
  bonusKopecks: string;
  toPayKopecks: string;
  /** Ведомость этого месяца проведена в кассу. */
  posted: boolean;
}

export interface StaffMoneyConfigDto {
  /** Заданы ли человеку личный оклад или личный процент. */
  hasPersonal: boolean;
  personalBaseSalaryKopecks: string | null;
  personalBonusPercent: number | null;
  ruleMode: PayrollMode;
  rulePieceworkPercent: number;
  ruleBaseSalaryKopecks: string;
  ruleBonusPercent: number;
  /** Процент от работ, по которому человеку реально платят (resolveWorkPercent). */
  effectiveWorkPercent: number;
}

export interface StaffMoneyDto {
  userId: string;
  fullName: string;
  isActive: boolean;
  config: StaffMoneyConfigDto;
  /** Начислено за месяц; null — расчёта нет (уволенный) или строки нет вовсе. */
  earnings: PayoutBreakdown | null;
  payouts: PayoutDto[];
  sheetRows: StaffMoneySheetRow[];
}

export function buildStaffMoney(input: {
  user: UserPayoutConfig;
  rule: PayrollRule;
  earnings: PayoutBreakdown | null;
  payouts: PayoutDto[];
  sheets: PayrollSheetDto[];
}): StaffMoneyDto {
  const { user, rule } = input;

  const sheetRows: StaffMoneySheetRow[] = [];
  for (const s of input.sheets) {
    const mine = (s.entries ?? []).filter((e) => e.employeeId === user.userId);
    if (mine.length === 0) continue;
    const sum = (pick: (e: PayrollSheetEntry) => number | null | undefined) =>
      mine.reduce((t, e) => t + (pick(e) ?? 0), 0);
    sheetRows.push({
      month: s.month,
      salaryKopecks: String(sum((e) => e.salaryKopecks)),
      pieceworkKopecks: String(sum((e) => e.pieceworkKopecks)),
      advanceKopecks: String(sum((e) => e.advanceKopecks)),
      bonusKopecks: String(sum((e) => e.bonusKopecks)),
      // «К выплате» — max(0) по каждой строке, а не от суммы: долг по одной строке
      // не гасит доплату по другой — ровно так ведомость проводится в кассу.
      toPayKopecks: String(mine.reduce((t, e) => t + entryToPayKopecks(e), 0)),
      posted: s.cashTransactionId !== null,
    });
  }
  sheetRows.sort((a, b) => b.month.localeCompare(a.month));

  const payouts = [...input.payouts].sort(
    (a, b) => b.paidOn.localeCompare(a.paidOn) || b.createdAt.localeCompare(a.createdAt),
  );

  return {
    userId: user.userId,
    fullName: user.fullName,
    isActive: user.isActive,
    config: {
      hasPersonal: hasPersonalRule(user),
      personalBaseSalaryKopecks:
        user.baseSalaryKopecks !== null ? user.baseSalaryKopecks.toString() : null,
      personalBonusPercent: user.bonusPercent,
      ruleMode: rule.mode,
      rulePieceworkPercent: rule.pieceworkPercent,
      ruleBaseSalaryKopecks: rule.baseSalaryKopecks,
      ruleBonusPercent: rule.bonusPercent,
      effectiveWorkPercent: resolveWorkPercent(rule, user),
    },
    earnings: user.isActive ? input.earnings : null,
    payouts,
    sheetRows,
  };
}

async function loadUser(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<UserPayoutConfig | null> {
  const rows = (await withTenantTx(db, tenantId, (tx) =>
    tx.execute(sql`
      SELECT id,
             full_name,
             is_active,
             payout_base_salary_kopecks::text AS base,
             payout_bonus_percent AS bonus
        FROM users
       WHERE id = ${userId}::uuid
         AND deleted_at IS NULL
       LIMIT 1
    `),
  )) as unknown as Array<{
    id: string;
    full_name: string;
    is_active: boolean;
    base: string | null;
    bonus: number | null;
  }>;
  const u = rows[0];
  if (!u) return null;
  return {
    userId: u.id,
    fullName: u.full_name,
    isActive: u.is_active,
    baseSalaryKopecks: u.base !== null ? BigInt(u.base) : null,
    bonusPercent: u.bonus,
  };
}

/** Границы месяца — UTC-полуинтервал, ровно как их строит страница «Зарплата». */
function monthBoundsUtc(month: string): { start: Date; end: Date } {
  const [y = 0, m = 0] = month.split('-').map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  };
}

export async function getStaffMoney(
  db: Db,
  tenantId: string,
  userId: string,
  month: string,
): Promise<StaffMoneyDto | null> {
  const user = await loadUser(db, tenantId, userId);
  if (!user) return null;
  const rule = await getRule(db, tenantId);
  const { start, end } = monthBoundsUtc(month);
  // По уволенному computePayouts не зовём: он вернул бы пустоту, а пустота на этой
  // вкладке — не то же самое, что «0 ₽» (buildStaffMoney дублирует эту гарантию).
  const earnings = user.isActive
    ? ((await computePayouts(db, tenantId, { start, end }, { engineerId: userId })).rows[0] ?? null)
    : null;
  const [payouts, sheets] = await Promise.all([
    listPayoutsByEngineer(db, tenantId, userId),
    listSheets(db, tenantId),
  ]);
  return buildStaffMoney({ user, rule, earnings, payouts, sheets });
}
