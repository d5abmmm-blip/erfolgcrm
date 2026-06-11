/**
 * Этап 9.C — Расчёт ЗП инженеров.
 *
 * Расчёт on-the-fly: история не хранится, считаем по сырым данным
 * (work_orders + work_order_lines + tickets + users.hourly_cost_rate).
 *
 * Логика принадлежности работы инженеру:
 *   1) work_order_lines.engineer_id (если задан) — конкретный инженер за конкретную строку.
 *   2) Если NULL → fallback на work_orders.engineer_id (главный исполнитель наряда).
 *
 * Учитываем только work_orders, ticket которых закрыт в периоде.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  engineerPayoutRules,
  withTenantTx,
  type Db,
} from '@erfolg/db';

export type PayrollMode = 'piecework' | 'salary_bonus';

export interface PayrollRule {
  tenantId: string;
  mode: PayrollMode;
  pieceworkPercent: number;
  baseSalaryKopecks: string;
  bonusPercent: number;
  updatedAt: Date;
}

const DEFAULT_RULE: Omit<PayrollRule, 'tenantId' | 'updatedAt'> = {
  mode: 'piecework',
  pieceworkPercent: 30,
  baseSalaryKopecks: '0',
  bonusPercent: 0,
};

function toRuleDto(row: typeof engineerPayoutRules.$inferSelect): PayrollRule {
  return {
    tenantId: row.tenantId,
    mode: row.mode,
    pieceworkPercent: row.pieceworkPercent,
    baseSalaryKopecks: row.baseSalaryKopecks.toString(),
    bonusPercent: row.bonusPercent,
    updatedAt: row.updatedAt,
  };
}

export async function getRule(db: Db, tenantId: string): Promise<PayrollRule> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(engineerPayoutRules)
      .where(eq(engineerPayoutRules.tenantId, tenantId))
      .limit(1);
    const row = rows[0];
    if (row) return toRuleDto(row);
    // Default
    return {
      tenantId,
      ...DEFAULT_RULE,
      updatedAt: new Date(0),
    };
  });
}

export interface SetRuleInput {
  mode: PayrollMode;
  pieceworkPercent?: number;
  baseSalaryKopecks?: bigint;
  bonusPercent?: number;
}

export async function setRule(
  db: Db,
  tenantId: string,
  input: SetRuleInput,
): Promise<PayrollRule> {
  return withTenantTx(db, tenantId, async (tx) => {
    const values = {
      tenantId,
      mode: input.mode,
      pieceworkPercent: input.pieceworkPercent ?? DEFAULT_RULE.pieceworkPercent,
      baseSalaryKopecks:
        input.baseSalaryKopecks ?? BigInt(DEFAULT_RULE.baseSalaryKopecks),
      bonusPercent: input.bonusPercent ?? DEFAULT_RULE.bonusPercent,
    };
    const inserted = await tx
      .insert(engineerPayoutRules)
      .values(values)
      .onConflictDoUpdate({
        target: engineerPayoutRules.tenantId,
        set: {
          mode: values.mode,
          pieceworkPercent: values.pieceworkPercent,
          baseSalaryKopecks: values.baseSalaryKopecks,
          bonusPercent: values.bonusPercent,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('setRule: insert returned nothing');
    return toRuleDto(row);
  });
}

export interface PayoutBreakdown {
  engineerId: string;
  engineerName: string;
  /** Сумма всех «work»-строк закрытых WO в периоде. */
  worksAmountKopecks: string;
  /** Сумма закрытых WO (для контекста). */
  closedOrdersTotalKopecks: string;
  /** Кол-во закрытых WO в периоде. */
  closedOrdersCount: number;
  /** Базовый оклад (для salary_bonus, иначе 0). */
  baseSalaryKopecks: string;
  /** Сумма бонуса (для salary_bonus) или сделки (для piecework). */
  pieceworkPartKopecks: string;
  /** Итого к выплате. */
  totalEarningsKopecks: string;
}

export interface PayoutComputeResult {
  rule: PayrollRule;
  period: { start: string; end: string };
  rows: PayoutBreakdown[];
  /** Сумма totalEarnings по всем инженерам. */
  grandTotalKopecks: string;
}

interface PerEngineerAggregate {
  engineerId: string;
  engineerName: string;
  worksAmount: bigint;
  ordersTotal: bigint;
  ordersCount: number;
}

async function loadAggregates(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  start: Date,
  end: Date,
  filterEngineerId: string | null,
): Promise<PerEngineerAggregate[]> {
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const engineerFilter = filterEngineerId
    ? sql`AND COALESCE(wol.engineer_id, wo.engineer_id) = ${filterEngineerId}::uuid`
    : sql``;

  // Работы (по строкам с типом 'work') — основной источник.
  const worksRows = (await tx.execute(sql`
    SELECT
      COALESCE(wol.engineer_id, wo.engineer_id) AS engineer_id,
      u.full_name AS engineer_name,
      COALESCE(SUM(wol.amount_kopecks), 0)::text AS works_amount
      FROM work_order_lines wol
      JOIN work_orders wo ON wo.id = wol.work_order_id
      JOIN tickets t      ON t.id = wo.ticket_id
      LEFT JOIN users u   ON u.id = COALESCE(wol.engineer_id, wo.engineer_id)
     WHERE t.status = 'closed'
       AND t.closed_at >= ${startIso}::timestamptz
       AND t.closed_at <  ${endIso}::timestamptz
       AND wol.line_type = 'work'
       AND COALESCE(wol.engineer_id, wo.engineer_id) IS NOT NULL
       ${engineerFilter}
     GROUP BY COALESCE(wol.engineer_id, wo.engineer_id), u.full_name
  `)) as unknown as Array<{
    engineer_id: string;
    engineer_name: string;
    works_amount: string;
  }>;

  // Стоимость закрытых нарядов и количество — для контекста (не для расчёта).
  // Считаем "наряд принадлежит инженеру" если он = work_orders.engineer_id.
  const ordersRows = (await tx.execute(sql`
    SELECT
      wo.engineer_id,
      u.full_name AS engineer_name,
      COUNT(*)::int AS orders_count,
      COALESCE(SUM(wo.total_amount_kopecks), 0)::text AS orders_total
      FROM work_orders wo
      JOIN tickets t ON t.id = wo.ticket_id
      LEFT JOIN users u ON u.id = wo.engineer_id
     WHERE t.status = 'closed'
       AND t.closed_at >= ${startIso}::timestamptz
       AND t.closed_at <  ${endIso}::timestamptz
       AND wo.engineer_id IS NOT NULL
       ${filterEngineerId ? sql`AND wo.engineer_id = ${filterEngineerId}::uuid` : sql``}
     GROUP BY wo.engineer_id, u.full_name
  `)) as unknown as Array<{
    engineer_id: string;
    engineer_name: string | null;
    orders_count: number;
    orders_total: string;
  }>;

  const map = new Map<string, PerEngineerAggregate>();
  for (const row of worksRows) {
    map.set(row.engineer_id, {
      engineerId: row.engineer_id,
      engineerName: row.engineer_name ?? '—',
      worksAmount: BigInt(row.works_amount),
      ordersTotal: 0n,
      ordersCount: 0,
    });
  }
  for (const row of ordersRows) {
    const existing = map.get(row.engineer_id);
    if (existing) {
      existing.ordersTotal = BigInt(row.orders_total);
      existing.ordersCount = row.orders_count;
    } else {
      // Инженер закрыл наряды без 'work'-строк — учитываем для прозрачности
      map.set(row.engineer_id, {
        engineerId: row.engineer_id,
        engineerName: row.engineer_name ?? '—',
        worksAmount: 0n,
        ordersTotal: BigInt(row.orders_total),
        ordersCount: row.orders_count,
      });
    }
  }
  return Array.from(map.values());
}

function computeRow(
  rule: PayrollRule,
  agg: PerEngineerAggregate,
): PayoutBreakdown {
  const works = agg.worksAmount;
  const piecePercent = BigInt(
    rule.mode === 'piecework' ? rule.pieceworkPercent : rule.bonusPercent,
  );
  const piecework = (works * piecePercent) / 100n;
  const base =
    rule.mode === 'salary_bonus'
      ? BigInt(rule.baseSalaryKopecks)
      : 0n;
  const total = base + piecework;
  return {
    engineerId: agg.engineerId,
    engineerName: agg.engineerName,
    worksAmountKopecks: works.toString(),
    closedOrdersTotalKopecks: agg.ordersTotal.toString(),
    closedOrdersCount: agg.ordersCount,
    baseSalaryKopecks: base.toString(),
    pieceworkPartKopecks: piecework.toString(),
    totalEarningsKopecks: total.toString(),
  };
}

export async function computePayouts(
  db: Db,
  tenantId: string,
  period: { start: Date; end: Date },
  opts: { engineerId?: string | null } = {},
): Promise<PayoutComputeResult> {
  const rule = await getRule(db, tenantId);
  const aggregates = await withTenantTx(db, tenantId, (tx) =>
    loadAggregates(tx, period.start, period.end, opts.engineerId ?? null),
  );
  const rows = aggregates
    .map((agg) => computeRow(rule, agg))
    .sort((a, b) => Number(BigInt(b.totalEarningsKopecks) - BigInt(a.totalEarningsKopecks)));
  const grandTotal = rows.reduce(
    (acc, r) => acc + BigInt(r.totalEarningsKopecks),
    0n,
  );
  return {
    rule,
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
    rows,
    grandTotalKopecks: grandTotal.toString(),
  };
}

// Re-export для тестов
export { engineerPayoutRules, and };
