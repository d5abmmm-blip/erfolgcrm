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
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  cashAccounts,
  cashCategories,
  cashTransactions,
  engineerPayoutRules,
  payrollPayouts,
  withTenantTx,
  type Db,
} from '@erfolg/db';
import { recalcAccountsInTx } from '../cash/repository';
import { withDbRetry } from '../../lib/db-retry';

export type PayrollMode = 'piecework' | 'salary_bonus';

/** Тип выплаты: аванс / окончательный расчёт / премия. */
export type PayoutKind = 'advance' | 'final' | 'bonus';

export interface PayrollRule {
  tenantId: string;
  mode: PayrollMode;
  pieceworkPercent: number;
  baseSalaryKopecks: string;
  bonusPercent: number;
  /** Видят ли инженеры свой заработок в личном кабинете. */
  engineersSeeEarnings: boolean;
  updatedAt: Date;
}

const DEFAULT_RULE: Omit<PayrollRule, 'tenantId' | 'updatedAt'> = {
  mode: 'piecework',
  pieceworkPercent: 30,
  baseSalaryKopecks: '0',
  bonusPercent: 0,
  engineersSeeEarnings: true,
};

function toRuleDto(row: typeof engineerPayoutRules.$inferSelect): PayrollRule {
  return {
    tenantId: row.tenantId,
    mode: row.mode,
    pieceworkPercent: row.pieceworkPercent,
    baseSalaryKopecks: row.baseSalaryKopecks.toString(),
    bonusPercent: row.bonusPercent,
    engineersSeeEarnings: row.engineersSeeEarnings,
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

export async function setRule(db: Db, tenantId: string, input: SetRuleInput): Promise<PayrollRule> {
  return withTenantTx(db, tenantId, async (tx) => {
    const values = {
      tenantId,
      mode: input.mode,
      pieceworkPercent: input.pieceworkPercent ?? DEFAULT_RULE.pieceworkPercent,
      baseSalaryKopecks: input.baseSalaryKopecks ?? BigInt(DEFAULT_RULE.baseSalaryKopecks),
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

/**
 * Переключить видимость заработка для инженеров. Отдельный upsert, чтобы флаг
 * можно было менять независимо от режима расчёта (setRule его не трогает).
 */
export async function setEngineersSeeEarnings(
  db: Db,
  tenantId: string,
  value: boolean,
): Promise<PayrollRule> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(engineerPayoutRules)
      .values({ tenantId, engineersSeeEarnings: value })
      .onConflictDoUpdate({
        target: engineerPayoutRules.tenantId,
        set: { engineersSeeEarnings: value, updatedAt: new Date() },
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('setEngineersSeeEarnings: insert returned nothing');
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
       AND t.deleted_at IS NULL
       AND t.closed_at >= ${startIso}::timestamptz
       AND t.closed_at <  ${endIso}::timestamptz
       AND wol.line_type = 'work'
       AND COALESCE(wol.engineer_id, wo.engineer_id) IS NOT NULL
       -- Только действующие сотрудники: заблокированных/уволенных (is_active=false) и
       -- удалённых в ведомость ЗП не показываем (в т.ч. служебные/легаси-аккаунты, под
       -- которыми закрывали наряды). Чтобы выплатить бывшему — временно сделать активным.
       AND u.is_active = true
       AND u.deleted_at IS NULL
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
       AND t.deleted_at IS NULL
       AND t.closed_at >= ${startIso}::timestamptz
       AND t.closed_at <  ${endIso}::timestamptz
       AND wo.engineer_id IS NOT NULL
       -- Только действующие сотрудники (см. коммент выше по works).
       AND u.is_active = true
       AND u.deleted_at IS NULL
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

/** Персональная настройка ЗП сотрудника (оба поля NULL ⇒ нет персонального правила). */
export interface UserPayoutConfig {
  userId: string;
  fullName: string;
  isActive: boolean;
  baseSalaryKopecks: bigint | null;
  bonusPercent: number | null;
}

function hasPersonalRule(cfg: UserPayoutConfig | undefined): cfg is UserPayoutConfig {
  // isActive: личный оклад/бонус — свойство РАБОТАЮЩЕГО сотрудника. Уволенный считается
  // по общему правилу (так же фильтрует loadUserPayoutConfigs: AND is_active = true).
  return !!cfg && cfg.isActive && (cfg.baseSalaryKopecks !== null || cfg.bonusPercent !== null);
}

/**
 * Процент от работ, по которому сотруднику платят за конкретную работу.
 *
 * 🔴 ЕДИНСТВЕННОЕ ОПРЕДЕЛЕНИЕ НА ВСЮ СИСТЕМУ. Им пользуются двое:
 *   1) расчёт зарплаты — `computeRow` ниже;
 *   2) себестоимость труда в строке наряда — `work-orders/repository.ts:resolveLineCost`.
 * Заведёте второе определение — себестоимость перестанет сходиться с выплатой.
 */
export function resolveWorkPercent(rule: PayrollRule, cfg?: UserPayoutConfig): number {
  if (hasPersonalRule(cfg)) return cfg.bonusPercent ?? 0;
  return rule.mode === 'piecework' ? rule.pieceworkPercent : rule.bonusPercent;
}

/**
 * Себестоимость ЕДИНИЦЫ работы = процент инженера от её цены.
 *
 * Почему не «ставка × часы»: на бою все строки работ заведены в «шт», а не в «час»
 * (замер 2026-07-24), поэтому часовая ставка умножалась бы на 1 и приравнивала
 * замену предохранителя к капремонту. Процент же — ровно те деньги, которые
 * инженер получит именно за эту работу.
 *
 * Усечение вниз — как в зарплате. Из-за хранения «на единицу» итог по строке может
 * отличаться от выплаты меньше чем на копейку за единицу, и всегда в меньшую сторону.
 */
export function laborCostPerUnitKopecks(unitPriceKopecks: bigint, percent: number): bigint {
  if (percent <= 0 || unitPriceKopecks <= 0n) return 0n;
  return (unitPriceKopecks * BigInt(percent)) / 100n;
}

/**
 * Процент конкретного сотрудника внутри УЖЕ ОТКРЫТОЙ транзакции тенанта.
 * Нужен себестоимости строки наряда, которая считается в той же транзакции,
 * что и сама строка. Читает то же и так же, что `getRule` + `loadUserPayoutConfigs`.
 */
export async function getEngineerWorkPercentTx(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  engineerId: string,
): Promise<number> {
  const ruleRows = await tx.select().from(engineerPayoutRules).limit(1);
  const rule: PayrollRule = ruleRows[0]
    ? toRuleDto(ruleRows[0])
    : { tenantId: '', ...DEFAULT_RULE, updatedAt: new Date(0) };

  const userRows = (await tx.execute(sql`
    SELECT id,
           full_name,
           is_active,
           payout_base_salary_kopecks::text AS base,
           payout_bonus_percent AS bonus
      FROM users
     WHERE id = ${engineerId}::uuid
       AND deleted_at IS NULL
     LIMIT 1
  `)) as unknown as Array<{
    id: string;
    full_name: string;
    is_active: boolean;
    base: string | null;
    bonus: number | null;
  }>;

  const u = userRows[0];
  const cfg: UserPayoutConfig | undefined = u
    ? {
        userId: u.id,
        fullName: u.full_name,
        isActive: u.is_active,
        baseSalaryKopecks: u.base !== null ? BigInt(u.base) : null,
        bonusPercent: u.bonus,
      }
    : undefined;

  return resolveWorkPercent(rule, cfg);
}

/**
 * Расчёт строки. Если у сотрудника задано ПЕРСОНАЛЬНОЕ правило (оклад/бонус) —
 * считаем «оклад + бонус% от работ» по его цифрам. Иначе — по глобальному rule.
 */
/**
 * Оклад — МЕСЯЧНЫЙ и прибавляется как есть (не масштабируется по длине периода) —
 * так же, как работало глобальное правило salary_bonus. Поэтому ведомость по окладам
 * корректна на вкладке «Месяц» (дефолт); на «День»/«Неделя» оклад покажется целиком.
 * Бонус/сделка (от работ) период-корректны (работы закрыты в окне периода).
 */
function computeRow(
  rule: PayrollRule,
  agg: PerEngineerAggregate,
  cfg?: UserPayoutConfig,
): PayoutBreakdown {
  const works = agg.worksAmount;
  // Процент берём ТОЛЬКО через общее определение — та же цифра идёт в себестоимость
  // труда в наряде (work-orders/resolveLineCost). Второго определения быть не должно.
  const piecework = (works * BigInt(resolveWorkPercent(rule, cfg))) / 100n;
  const base = hasPersonalRule(cfg)
    ? (cfg.baseSalaryKopecks ?? 0n)
    : rule.mode === 'salary_bonus'
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

/**
 * Персональные правила ЗП сотрудников (у кого задан оклад или бонус).
 * Используется двояко: (1) применить персональное правило к тем, у кого есть работы;
 * (2) добавить в расчёт «окладников» без работ за период (диспетчер/директор) —
 * но только АКТИВНЫХ, чтобы не начислять оклад уволенным без выработки.
 */
async function loadUserPayoutConfigs(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  filterUserId: string | null,
): Promise<Map<string, UserPayoutConfig>> {
  // ТОЛЬКО активные: персональный оклад/бонус — свойство работающего сотрудника.
  // Уволенный (is_active=false) не должен получать оклад — за работы в периоде,
  // если они есть, он оплачивается по глобальному правилу (см. computePayouts).
  const rows = (await tx.execute(sql`
    SELECT id,
           full_name,
           is_active,
           payout_base_salary_kopecks::text AS base,
           payout_bonus_percent AS bonus
      FROM users
     WHERE deleted_at IS NULL
       AND is_active = true
       AND (payout_base_salary_kopecks IS NOT NULL OR payout_bonus_percent IS NOT NULL)
       ${filterUserId ? sql`AND id = ${filterUserId}::uuid` : sql``}
  `)) as unknown as Array<{
    id: string;
    full_name: string;
    is_active: boolean;
    base: string | null;
    bonus: number | null;
  }>;
  const map = new Map<string, UserPayoutConfig>();
  for (const r of rows) {
    map.set(r.id, {
      userId: r.id,
      fullName: r.full_name,
      isActive: r.is_active,
      baseSalaryKopecks: r.base !== null ? BigInt(r.base) : null,
      bonusPercent: r.bonus,
    });
  }
  return map;
}

export async function computePayouts(
  db: Db,
  tenantId: string,
  period: { start: Date; end: Date },
  opts: { engineerId?: string | null } = {},
): Promise<PayoutComputeResult> {
  const rule = await getRule(db, tenantId);
  const filterId = opts.engineerId ?? null;
  const { aggregates, configs } = await withTenantTx(db, tenantId, async (tx) => ({
    aggregates: await loadAggregates(tx, period.start, period.end, filterId),
    configs: await loadUserPayoutConfigs(tx, filterId),
  }));

  // Плательщики = у кого есть работы ∪ активные окладники (персональное правило) без работ.
  const byId = new Map<string, { agg: PerEngineerAggregate; cfg?: UserPayoutConfig }>();
  for (const agg of aggregates) byId.set(agg.engineerId, { agg });
  for (const cfg of configs.values()) {
    const existing = byId.get(cfg.userId);
    if (existing) {
      existing.cfg = cfg;
    } else if (cfg.isActive) {
      byId.set(cfg.userId, {
        agg: {
          engineerId: cfg.userId,
          engineerName: cfg.fullName,
          worksAmount: 0n,
          ordersTotal: 0n,
          ordersCount: 0,
        },
        cfg,
      });
    }
  }

  const rows = [...byId.values()]
    .map(({ agg, cfg }) => computeRow(rule, agg, cfg))
    .sort((a, b) => Number(BigInt(b.totalEarningsKopecks) - BigInt(a.totalEarningsKopecks)));
  const grandTotal = rows.reduce((acc, r) => acc + BigInt(r.totalEarningsKopecks), 0n);
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

/* ────────────────────────── Выплаты ЗП ───────────────────────── */

type Tx = Parameters<Parameters<typeof withTenantTx>[2]>[0];

export interface PayoutDto {
  id: string;
  engineerId: string;
  kind: PayoutKind;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  computedKopecks: string;
  amountKopecks: string;
  paidOn: string;
  accountId: string;
  cashTransactionId: string | null;
  comment: string | null;
  createdAt: string;
}

function toPayoutDto(row: typeof payrollPayouts.$inferSelect): PayoutDto {
  return {
    id: row.id,
    engineerId: row.engineerId,
    kind: row.kind,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    periodLabel: row.periodLabel,
    computedKopecks: row.computedKopecks.toString(),
    amountKopecks: row.amountKopecks.toString(),
    paidOn: row.paidOn,
    accountId: row.accountId,
    cashTransactionId: row.cashTransactionId,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Статья расхода по имени — найти или создать (переиспользуем seed'овую). */
async function ensureExpenseCategory(tx: Tx, tenantId: string, name: string): Promise<string> {
  const existing = await tx
    .select({ id: cashCategories.id })
    .from(cashCategories)
    .where(
      and(
        eq(cashCategories.tenantId, tenantId),
        eq(cashCategories.direction, 'expense'),
        eq(cashCategories.name, name),
        isNull(cashCategories.deletedAt),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await tx
    .insert(cashCategories)
    .values({ tenantId, name, direction: 'expense', isSystem: true })
    .returning({ id: cashCategories.id });
  return inserted[0]!.id;
}

/** Статья расхода в кассе для выплаты данного типа: премия — «Премии», иначе «Зарплата». */
function categoryNameForKind(kind: PayoutKind): string {
  return kind === 'bonus' ? 'Премии' : 'Зарплата';
}

export interface CreatePayoutInput {
  engineerId: string;
  kind: PayoutKind;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  computedKopecks: bigint;
  amountKopecks: bigint;
  paidOn: string;
  accountId: string;
  comment: string | null;
  createdBy: string | null;
}

const KIND_LABEL: Record<PayoutKind, string> = {
  advance: 'аванс',
  final: 'окончательный расчёт',
  bonus: 'премия',
};

/**
 * Провести выплату: создать расход в кассе (статья «Зарплата») + запись выплаты,
 * пересчитать остаток счёта. Всё в одной tenant-tx.
 */
export async function createPayout(
  db: Db,
  tenantId: string,
  input: CreatePayoutInput,
): Promise<PayoutDto> {
  return withDbRetry('payroll.createPayout', () =>
    withTenantTx(db, tenantId, async (tx) => {
      const acc = await tx
        .select({ id: cashAccounts.id })
        .from(cashAccounts)
        .where(
          and(
            eq(cashAccounts.tenantId, tenantId),
            eq(cashAccounts.id, input.accountId),
            isNull(cashAccounts.deletedAt),
          ),
        )
        .limit(1);
      if (!acc[0]) throw new Error('Денежный счёт не найден');

      // Дубль ловим только для аванса/расчёта (по типу): один advance и один final на
      // период. Премий ('bonus') может быть несколько — их не дедуплицируем.
      if (input.kind !== 'bonus') {
        const dup = await tx
          .select({ id: payrollPayouts.id })
          .from(payrollPayouts)
          .where(
            and(
              eq(payrollPayouts.tenantId, tenantId),
              eq(payrollPayouts.engineerId, input.engineerId),
              eq(payrollPayouts.periodStart, input.periodStart),
              eq(payrollPayouts.kind, input.kind),
              isNull(payrollPayouts.deletedAt),
            ),
          )
          .limit(1);
        if (dup[0]) {
          throw new Error(`За этот период инженеру уже проведён ${KIND_LABEL[input.kind]}`);
        }
      }

      const categoryId = await ensureExpenseCategory(tx, tenantId, categoryNameForKind(input.kind));
      const comment = input.comment?.trim() || (input.kind === 'bonus' ? 'Премия' : 'Выплата ЗП');

      const cashRow = await tx
        .insert(cashTransactions)
        .values({
          tenantId,
          kind: 'expense',
          accountId: input.accountId,
          categoryId,
          amountKopecks: input.amountKopecks,
          occurredOn: input.paidOn,
          comment,
          userId: input.createdBy,
          source: 'manual',
        })
        .returning({ id: cashTransactions.id });
      const cashTxId = cashRow[0]!.id;
      await recalcAccountsInTx(tx, tenantId, [input.accountId]);

      const payoutRow = await tx
        .insert(payrollPayouts)
        .values({
          tenantId,
          engineerId: input.engineerId,
          kind: input.kind,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          periodLabel: input.periodLabel,
          computedKopecks: input.computedKopecks,
          amountKopecks: input.amountKopecks,
          paidOn: input.paidOn,
          accountId: input.accountId,
          cashTransactionId: cashTxId,
          comment: input.comment,
          createdBy: input.createdBy,
        })
        .returning();
      return toPayoutDto(payoutRow[0]!);
    }),
  );
}

export interface UpdatePayoutInput {
  amountKopecks?: bigint;
  paidOn?: string;
  accountId?: string;
  comment?: string | null;
}

/**
 * Ручная правка выплаты: сумма/дата/счёт/комментарий. Расход в кассе пересоздаётся
 * (старый мягко удаляется), остатки задействованных счетов пересчитываются.
 */
export async function updatePayout(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdatePayoutInput,
): Promise<PayoutDto | null> {
  return withDbRetry('payroll.updatePayout', () =>
    withTenantTx(db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(payrollPayouts)
        .where(
          and(
            eq(payrollPayouts.tenantId, tenantId),
            eq(payrollPayouts.id, id),
            isNull(payrollPayouts.deletedAt),
          ),
        )
        .limit(1);
      const cur = rows[0];
      if (!cur) return null;

      const newAmount = patch.amountKopecks ?? cur.amountKopecks;
      const newPaidOn = patch.paidOn ?? cur.paidOn;
      const newAccountId = patch.accountId ?? cur.accountId;
      const newComment = patch.comment !== undefined ? patch.comment : cur.comment;

      if (newAccountId !== cur.accountId) {
        const acc = await tx
          .select({ id: cashAccounts.id })
          .from(cashAccounts)
          .where(
            and(
              eq(cashAccounts.tenantId, tenantId),
              eq(cashAccounts.id, newAccountId),
              isNull(cashAccounts.deletedAt),
            ),
          )
          .limit(1);
        if (!acc[0]) throw new Error('Денежный счёт не найден');
      }

      if (cur.cashTransactionId) {
        await tx
          .update(cashTransactions)
          .set({ deletedAt: new Date() })
          .where(eq(cashTransactions.id, cur.cashTransactionId));
      }
      const categoryId = await ensureExpenseCategory(tx, tenantId, categoryNameForKind(cur.kind));
      const cashRow = await tx
        .insert(cashTransactions)
        .values({
          tenantId,
          kind: 'expense',
          accountId: newAccountId,
          categoryId,
          amountKopecks: newAmount,
          occurredOn: newPaidOn,
          comment: newComment?.trim() || 'Выплата ЗП',
          userId: cur.createdBy,
          source: 'manual',
        })
        .returning({ id: cashTransactions.id });
      const newCashTxId = cashRow[0]!.id;

      // Пересчёт остатков затронутых счетов; recalcAccountsInTx лочит их по возрастанию
      // id (детерминированно против deadlock со встречной операцией по тем же счетам).
      await recalcAccountsInTx(tx, tenantId, [cur.accountId, newAccountId]);

      const updated = await tx
        .update(payrollPayouts)
        .set({
          amountKopecks: newAmount,
          paidOn: newPaidOn,
          accountId: newAccountId,
          comment: newComment,
          cashTransactionId: newCashTxId,
        })
        .where(eq(payrollPayouts.id, id))
        .returning();
      return toPayoutDto(updated[0]!);
    }),
  );
}

/** Отмена выплаты: мягко удаляем расход в кассе + пересчёт + мягко удаляем выплату. */
export async function deletePayout(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withDbRetry('payroll.deletePayout', () =>
    withTenantTx(db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: payrollPayouts.id,
          cashTransactionId: payrollPayouts.cashTransactionId,
          accountId: payrollPayouts.accountId,
        })
        .from(payrollPayouts)
        .where(
          and(
            eq(payrollPayouts.tenantId, tenantId),
            eq(payrollPayouts.id, id),
            isNull(payrollPayouts.deletedAt),
          ),
        )
        .limit(1);
      const cur = rows[0];
      if (!cur) return false;
      if (cur.cashTransactionId) {
        await tx
          .update(cashTransactions)
          .set({ deletedAt: new Date() })
          .where(eq(cashTransactions.id, cur.cashTransactionId));
        await recalcAccountsInTx(tx, tenantId, [cur.accountId]);
      }
      await tx
        .update(payrollPayouts)
        .set({ deletedAt: new Date() })
        .where(eq(payrollPayouts.id, id));
      return true;
    }),
  );
}

/** Выплаты за период (по period_start) — чтобы показать «Выплачено» в таблице. */
export async function listPayouts(
  db: Db,
  tenantId: string,
  periodStart: string,
): Promise<PayoutDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(payrollPayouts)
      .where(
        and(
          eq(payrollPayouts.tenantId, tenantId),
          eq(payrollPayouts.periodStart, periodStart),
          isNull(payrollPayouts.deletedAt),
        ),
      );
    return rows.map(toPayoutDto);
  });
}

// Re-export для тестов
export { engineerPayoutRules, payrollPayouts, and };
