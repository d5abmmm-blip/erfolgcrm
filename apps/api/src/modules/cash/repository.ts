/**
 * Repository кассы (ДДС): счета, статьи, операции + материализованный остаток.
 *
 * recalcAccountBalanceInTx — полный пересчёт остатка счёта под FOR UPDATE
 * (образец — payments.recalcPaidAmountInTx): никаких «balance += delta», всегда
 * SUM по живым операциям. Все мутации обёрнуты в withDbRetry + withTenantTx.
 *
 * Перевод между счетами — ОДНА запись kind='transfer' (account_id=откуда,
 * counter_account_id=куда). Пересчитываем оба счёта; лочим в порядке возрастания id
 * (детерминированно против deadlock встречных переводов).
 *
 * Все суммы — копейки (bigint, в DTO → string). occurred_on — date 'YYYY-MM-DD'.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  cashAccounts,
  cashCategories,
  cashTransactions,
  withTenantTx,
  type Db,
} from '@erfolg/db';
import { withDbRetry } from '../../lib/db-retry';

type Tx = Parameters<Parameters<typeof withTenantTx>[2]>[0];

export type CashAccountKind = 'cash' | 'bank' | 'card';
export type CashDirection = 'income' | 'expense';
export type CashTxKind = 'income' | 'expense' | 'transfer';
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer';

/* ───────────────────────────── DTO ───────────────────────────── */

export interface CashAccountDto {
  id: string;
  name: string;
  kind: CashAccountKind;
  openingBalanceKopecks: string;
  balanceKopecks: string;
  defaultForMethod: PaymentMethod | null;
  isArchived: boolean;
  sortOrder: number;
}

export interface CashCategoryDto {
  id: string;
  name: string;
  direction: CashDirection;
  isSystem: boolean;
  systemCode: string | null;
  isArchived: boolean;
  sortOrder: number;
}

export interface CashTransactionDto {
  id: string;
  kind: CashTxKind;
  accountId: string;
  accountName: string | null;
  counterAccountId: string | null;
  counterAccountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  amountKopecks: string;
  occurredOn: string;
  comment: string | null;
  counterparty: string | null;
  clientId: string | null;
  clientName: string | null;
  source: 'manual' | 'payment';
}

function accountToDto(row: typeof cashAccounts.$inferSelect): CashAccountDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    openingBalanceKopecks: row.openingBalanceKopecks.toString(),
    balanceKopecks: row.balanceKopecks.toString(),
    defaultForMethod: row.defaultForMethod,
    isArchived: row.isArchived,
    sortOrder: row.sortOrder,
  };
}

function categoryToDto(row: typeof cashCategories.$inferSelect): CashCategoryDto {
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    isSystem: row.isSystem,
    systemCode: row.systemCode,
    isArchived: row.isArchived,
    sortOrder: row.sortOrder,
  };
}

/* ──────────────────── Материализация остатка ──────────────────── */

/**
 * Полный пересчёт balance_kopecks одного счёта под FOR UPDATE.
 *   balance = opening + Σ(income сюда) − Σ(expense отсюда)
 *                     − Σ(transfer отсюда) + Σ(transfer сюда)
 * Возвращает новый остаток. Если счёт не найден — no-op, возвращает 0.
 */
export async function recalcAccountBalanceInTx(
  tx: Tx,
  tenantId: string,
  accountId: string,
): Promise<bigint> {
  const accRows = await tx
    .select({ opening: cashAccounts.openingBalanceKopecks })
    .from(cashAccounts)
    .where(and(eq(cashAccounts.id, accountId), eq(cashAccounts.tenantId, tenantId)))
    .for('update')
    .limit(1);
  const acc = accRows[0];
  if (!acc) return 0n;

  const rows = (await tx.execute(sql`
    SELECT COALESCE(SUM(
      CASE
        WHEN kind = 'income'   AND account_id = ${accountId}::uuid THEN amount_kopecks
        WHEN kind = 'expense'  AND account_id = ${accountId}::uuid THEN -amount_kopecks
        WHEN kind = 'transfer' AND account_id = ${accountId}::uuid THEN -amount_kopecks
        WHEN kind = 'transfer' AND counter_account_id = ${accountId}::uuid THEN amount_kopecks
        ELSE 0
      END
    )::text, '0') AS delta
      FROM cash_transactions
     WHERE deleted_at IS NULL
       AND (account_id = ${accountId}::uuid OR counter_account_id = ${accountId}::uuid)
  `)) as unknown as Array<{ delta: string }>;

  const delta = BigInt(rows[0]?.delta ?? '0');
  const balance = acc.opening + delta;
  await tx
    .update(cashAccounts)
    .set({ balanceKopecks: balance })
    .where(and(eq(cashAccounts.id, accountId), eq(cashAccounts.tenantId, tenantId)));
  return balance;
}

/** Пересчёт нескольких счетов в детерминированном порядке (против deadlock). */
/**
 * Пересчёт нескольких счетов в ОДНОЙ транзакции. Счета лочатся (FOR UPDATE внутри
 * recalcAccountBalanceInTx) в порядке возрастания id — детерминированно против deadlock
 * встречных операций по тем же двум счетам. Экспортируется для переиспользования
 * (напр. выплаты ЗП в payroll затрагивают до двух счетов).
 */
export async function recalcAccountsInTx(
  tx: Tx,
  tenantId: string,
  accountIds: Array<string | null | undefined>,
): Promise<void> {
  const unique = [...new Set(accountIds.filter((x): x is string => !!x))].sort();
  for (const id of unique) {
    await recalcAccountBalanceInTx(tx, tenantId, id);
  }
}

/* ────────────────────────── Счета (CRUD) ─────────────────────── */

export async function listAccounts(
  db: Db,
  tenantId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<CashAccountDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(cashAccounts)
      .where(
        opts.includeArchived
          ? isNull(cashAccounts.deletedAt)
          : and(isNull(cashAccounts.deletedAt), eq(cashAccounts.isArchived, false)),
      )
      .orderBy(asc(cashAccounts.sortOrder), asc(cashAccounts.createdAt));
    return rows.map(accountToDto);
  });
}

export interface CreateAccountInput {
  name: string;
  kind: CashAccountKind;
  openingBalanceKopecks?: bigint;
  defaultForMethod?: PaymentMethod | null;
  sortOrder?: number;
}

export async function createAccount(
  db: Db,
  tenantId: string,
  input: CreateAccountInput,
): Promise<CashAccountDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const opening = input.openingBalanceKopecks ?? 0n;
    const inserted = await tx
      .insert(cashAccounts)
      .values({
        tenantId,
        name: input.name,
        kind: input.kind,
        openingBalanceKopecks: opening,
        balanceKopecks: opening,
        defaultForMethod: input.defaultForMethod ?? null,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('createAccount: insert returned nothing');
    return accountToDto(row);
  });
}

export interface UpdateAccountInput {
  name?: string;
  kind?: CashAccountKind;
  openingBalanceKopecks?: bigint;
  defaultForMethod?: PaymentMethod | null;
  isArchived?: boolean;
  sortOrder?: number;
}

export async function updateAccount(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateAccountInput,
): Promise<CashAccountDto | null> {
  return withDbRetry('cash.updateAccount', () =>
    withTenantTx(db, tenantId, async (tx) => {
      const existing = await tx
        .select({ id: cashAccounts.id })
        .from(cashAccounts)
        .where(and(eq(cashAccounts.id, id), isNull(cashAccounts.deletedAt)))
        .for('update')
        .limit(1);
      if (existing.length === 0) return null;

      const set: Partial<typeof cashAccounts.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.defaultForMethod !== undefined) set.defaultForMethod = patch.defaultForMethod;
      if (patch.isArchived !== undefined) set.isArchived = patch.isArchived;
      if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
      if (patch.openingBalanceKopecks !== undefined) set.openingBalanceKopecks = patch.openingBalanceKopecks;

      if (Object.keys(set).length > 0) {
        await tx
          .update(cashAccounts)
          .set(set)
          .where(and(eq(cashAccounts.id, id), eq(cashAccounts.tenantId, tenantId)));
      }
      // Стартовый остаток влияет на текущий — пересчитываем.
      if (patch.openingBalanceKopecks !== undefined) {
        await recalcAccountBalanceInTx(tx, tenantId, id);
      }
      const rows = await tx.select().from(cashAccounts).where(eq(cashAccounts.id, id)).limit(1);
      return rows[0] ? accountToDto(rows[0]) : null;
    }),
  );
}

/**
 * Удаление счёта: если по нему есть живые операции — только архивируем (деньги в истории
 * не теряем). Если операций нет — мягкое удаление. Возвращает фактическое действие.
 */
export async function deleteAccount(
  db: Db,
  tenantId: string,
  id: string,
): Promise<'deleted' | 'archived' | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const existing = await tx
      .select({ id: cashAccounts.id })
      .from(cashAccounts)
      .where(and(eq(cashAccounts.id, id), isNull(cashAccounts.deletedAt)))
      .limit(1);
    if (existing.length === 0) return null;

    const used = await tx
      .select({ id: cashTransactions.id })
      .from(cashTransactions)
      .where(
        and(
          isNull(cashTransactions.deletedAt),
          sql`(${cashTransactions.accountId} = ${id} OR ${cashTransactions.counterAccountId} = ${id})`,
        ),
      )
      .limit(1);

    if (used.length > 0) {
      await tx
        .update(cashAccounts)
        .set({ isArchived: true })
        .where(and(eq(cashAccounts.id, id), eq(cashAccounts.tenantId, tenantId)));
      return 'archived';
    }
    await tx
      .update(cashAccounts)
      .set({ deletedAt: new Date() })
      .where(and(eq(cashAccounts.id, id), eq(cashAccounts.tenantId, tenantId)));
    return 'deleted';
  });
}

/* ─────────────────────── Статьи (CRUD) ───────────────────────── */

export async function listCategories(
  db: Db,
  tenantId: string,
  opts: { direction?: CashDirection; includeArchived?: boolean } = {},
): Promise<CashCategoryDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const conds = [isNull(cashCategories.deletedAt)];
    if (opts.direction) conds.push(eq(cashCategories.direction, opts.direction));
    if (!opts.includeArchived) conds.push(eq(cashCategories.isArchived, false));
    const rows = await tx
      .select()
      .from(cashCategories)
      .where(and(...conds))
      .orderBy(asc(cashCategories.sortOrder), asc(cashCategories.name));
    return rows.map(categoryToDto);
  });
}

export async function createCategory(
  db: Db,
  tenantId: string,
  input: { name: string; direction: CashDirection; sortOrder?: number },
): Promise<CashCategoryDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(cashCategories)
      .values({
        tenantId,
        name: input.name,
        direction: input.direction,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('createCategory: insert returned nothing');
    return categoryToDto(row);
  });
}

export async function updateCategory(
  db: Db,
  tenantId: string,
  id: string,
  patch: { name?: string; isArchived?: boolean; sortOrder?: number },
): Promise<CashCategoryDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const set: Partial<typeof cashCategories.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.isArchived !== undefined) set.isArchived = patch.isArchived;
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
    if (Object.keys(set).length === 0) {
      const rows = await tx.select().from(cashCategories).where(eq(cashCategories.id, id)).limit(1);
      return rows[0] ? categoryToDto(rows[0]) : null;
    }
    const updated = await tx
      .update(cashCategories)
      .set(set)
      .where(and(eq(cashCategories.id, id), isNull(cashCategories.deletedAt)))
      .returning();
    return updated[0] ? categoryToDto(updated[0]) : null;
  });
}

/* ────────────────────────── Операции ─────────────────────────── */

export interface CreateTransactionInput {
  kind: CashTxKind;
  accountId: string;
  counterAccountId?: string | null;
  categoryId?: string | null;
  amountKopecks: bigint;
  occurredOn: string;
  comment?: string | null;
  counterparty?: string | null;
  clientId?: string | null;
  userId: string | null;
}

async function liveAccountExists(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: cashAccounts.id })
    .from(cashAccounts)
    .where(and(eq(cashAccounts.id, id), isNull(cashAccounts.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Создать операцию доход/расход/перевод. Валидирует счета и статью, вставляет запись
 * и пересчитывает остатки затронутых счетов в той же транзакции.
 */
export async function createTransaction(
  db: Db,
  tenantId: string,
  input: CreateTransactionInput,
): Promise<{ id: string }> {
  if (input.amountKopecks <= 0n) {
    throw new Error('Сумма должна быть больше нуля');
  }
  return withDbRetry('cash.createTransaction', () =>
    withTenantTx(db, tenantId, async (tx) => {
      if (!(await liveAccountExists(tx, input.accountId))) {
        throw new Error('Счёт не найден');
      }

      let counterAccountId: string | null = null;
      let categoryId: string | null = null;

      if (input.kind === 'transfer') {
        if (!input.counterAccountId) throw new Error('Для перевода нужен счёт-получатель');
        if (input.counterAccountId === input.accountId) {
          throw new Error('Нельзя переводить на тот же счёт');
        }
        if (!(await liveAccountExists(tx, input.counterAccountId))) {
          throw new Error('Счёт-получатель не найден');
        }
        counterAccountId = input.counterAccountId;
      } else {
        if (input.categoryId) {
          const catRows = await tx
            .select({ direction: cashCategories.direction })
            .from(cashCategories)
            .where(and(eq(cashCategories.id, input.categoryId), isNull(cashCategories.deletedAt)))
            .limit(1);
          const cat = catRows[0];
          if (!cat) throw new Error('Статья не найдена');
          if (cat.direction !== input.kind) {
            throw new Error('Статья не соответствует типу операции');
          }
          categoryId = input.categoryId;
        }
      }

      const inserted = await tx
        .insert(cashTransactions)
        .values({
          tenantId,
          kind: input.kind,
          accountId: input.accountId,
          counterAccountId,
          categoryId,
          amountKopecks: input.amountKopecks,
          occurredOn: input.occurredOn,
          comment: input.comment ?? null,
          counterparty: input.counterparty ?? null,
          clientId: input.clientId ?? null,
          userId: input.userId,
          source: 'manual',
        })
        .returning({ id: cashTransactions.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error('createTransaction: insert returned nothing');

      await recalcAccountsInTx(tx, tenantId, [input.accountId, counterAccountId]);
      return { id };
    }),
  );
}

export async function deleteTransaction(
  db: Db,
  tenantId: string,
  id: string,
): Promise<boolean> {
  return withDbRetry('cash.deleteTransaction', () =>
    withTenantTx(db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          accountId: cashTransactions.accountId,
          counterAccountId: cashTransactions.counterAccountId,
        })
        .from(cashTransactions)
        .where(and(eq(cashTransactions.id, id), isNull(cashTransactions.deletedAt)))
        .limit(1);
      const row = rows[0];
      if (!row) return false;
      await tx
        .update(cashTransactions)
        .set({ deletedAt: new Date() })
        .where(and(eq(cashTransactions.id, id), eq(cashTransactions.tenantId, tenantId)));
      await recalcAccountsInTx(tx, tenantId, [row.accountId, row.counterAccountId]);
      return true;
    }),
  );
}

export interface TransactionFilter {
  kind?: CashTxKind;
  accountId?: string;
  categoryId?: string;
  from?: string;
  to?: string;
  clientId?: string;
}

export async function listTransactions(
  db: Db,
  tenantId: string,
  filter: TransactionFilter,
  limit: number,
  offset: number,
): Promise<{ items: CashTransactionDto[]; total: number }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const conds = [sql`ct.deleted_at IS NULL`];
    if (filter.kind) conds.push(sql`ct.kind = ${filter.kind}::cash_tx_kind`);
    if (filter.accountId) {
      conds.push(
        sql`(ct.account_id = ${filter.accountId}::uuid OR ct.counter_account_id = ${filter.accountId}::uuid)`,
      );
    }
    if (filter.categoryId) conds.push(sql`ct.category_id = ${filter.categoryId}::uuid`);
    if (filter.clientId) conds.push(sql`ct.client_id = ${filter.clientId}::uuid`);
    if (filter.from) conds.push(sql`ct.occurred_on >= ${filter.from}::date`);
    if (filter.to) conds.push(sql`ct.occurred_on <= ${filter.to}::date`);
    const whereSql = sql.join(conds, sql` AND `);

    const itemRows = (await tx.execute(sql`
      SELECT
        ct.id                         AS "id",
        ct.kind                       AS "kind",
        ct.account_id                 AS "accountId",
        acc.name                      AS "accountName",
        ct.counter_account_id         AS "counterAccountId",
        cacc.name                     AS "counterAccountName",
        ct.category_id                AS "categoryId",
        cat.name                      AS "categoryName",
        ct.amount_kopecks::text       AS "amountKopecks",
        to_char(ct.occurred_on, 'YYYY-MM-DD') AS "occurredOn",
        ct.comment                    AS "comment",
        ct.counterparty               AS "counterparty",
        ct.client_id                  AS "clientId",
        cl.display_name               AS "clientName",
        ct.source                     AS "source"
      FROM cash_transactions ct
      LEFT JOIN cash_accounts   acc  ON acc.id  = ct.account_id
      LEFT JOIN cash_accounts   cacc ON cacc.id = ct.counter_account_id
      LEFT JOIN cash_categories cat  ON cat.id  = ct.category_id
      LEFT JOIN clients         cl   ON cl.id   = ct.client_id
      WHERE ${whereSql}
      ORDER BY ct.occurred_on DESC, ct.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `)) as unknown as CashTransactionDto[];

    const countRows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM cash_transactions ct WHERE ${whereSql}
    `)) as unknown as Array<{ cnt: number }>;

    return { items: itemRows, total: countRows[0]?.cnt ?? 0 };
  });
}

/* ────────────────────────── Агрегаты ─────────────────────────── */

export interface AccountBalancesReport {
  accounts: CashAccountDto[];
  totalKopecks: string;
  cashKopecks: string;
  nonCashKopecks: string;
}

/** Остатки по активным счетам + итоги (всего, наличные, безнал). */
export async function getAccountBalances(
  db: Db,
  tenantId: string,
): Promise<AccountBalancesReport> {
  const accounts = await listAccounts(db, tenantId, { includeArchived: false });
  let total = 0n;
  let cash = 0n;
  let nonCash = 0n;
  for (const a of accounts) {
    const b = BigInt(a.balanceKopecks);
    total += b;
    if (a.kind === 'cash') cash += b;
    else nonCash += b;
  }
  return {
    accounts,
    totalKopecks: total.toString(),
    cashKopecks: cash.toString(),
    nonCashKopecks: nonCash.toString(),
  };
}

export interface PeriodInput {
  /** Включительно (UTC date). */
  start: Date;
  /** Исключительно (UTC date). */
  end: Date;
}

export interface PeriodSummary {
  incomeKopecks: string;
  expenseKopecks: string;
  profitKopecks: string;
  /** Расходы по статьям, по убыванию суммы. */
  expenseByCategory: Array<{ categoryId: string | null; categoryName: string; amountKopecks: string }>;
  incomeByCategory: Array<{ categoryId: string | null; categoryName: string; amountKopecks: string }>;
  /** Приход за период по типу счёта (способу): наличные / карта / безнал. Для «собрано сегодня». */
  incomeByKind: { cashKopecks: string; cardKopecks: string; bankKopecks: string };
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Приход/расход/прибыль за период + разбивка по статьям (переводы исключены). */
export async function getPeriodSummary(
  db: Db,
  tenantId: string,
  period: PeriodInput,
): Promise<PeriodSummary> {
  return withTenantTx(db, tenantId, async (tx) => {
    const from = dateOnly(period.start);
    // end эксклюзивен → берём строго меньше даты end.
    const toExcl = dateOnly(period.end);

    const totalRows = (await tx.execute(sql`
      SELECT
        COALESCE(SUM(amount_kopecks) FILTER (WHERE kind='income')::text, '0')  AS income,
        COALESCE(SUM(amount_kopecks) FILTER (WHERE kind='expense')::text, '0') AS expense
      FROM cash_transactions
      WHERE deleted_at IS NULL
        AND kind <> 'transfer'
        AND occurred_on >= ${from}::date
        AND occurred_on <  ${toExcl}::date
    `)) as unknown as Array<{ income: string; expense: string }>;
    const income = BigInt(totalRows[0]?.income ?? '0');
    const expense = BigInt(totalRows[0]?.expense ?? '0');

    const byCat = (await tx.execute(sql`
      SELECT
        ct.kind                                  AS "kind",
        ct.category_id                           AS "categoryId",
        COALESCE(cat.name, 'Без статьи')         AS "categoryName",
        COALESCE(SUM(ct.amount_kopecks)::text, '0') AS "amountKopecks"
      FROM cash_transactions ct
      LEFT JOIN cash_categories cat ON cat.id = ct.category_id
      WHERE ct.deleted_at IS NULL
        AND ct.kind <> 'transfer'
        AND ct.occurred_on >= ${from}::date
        AND ct.occurred_on <  ${toExcl}::date
      GROUP BY ct.kind, ct.category_id, cat.name
      ORDER BY SUM(ct.amount_kopecks) DESC
    `)) as unknown as Array<{
      kind: CashDirection;
      categoryId: string | null;
      categoryName: string;
      amountKopecks: string;
    }>;

    // Приход по типу счёта (способу): наличные / карта / банк.
    const byKindRows = (await tx.execute(sql`
      SELECT a.kind AS "kind",
             COALESCE(SUM(ct.amount_kopecks)::text, '0') AS "amountKopecks"
      FROM cash_transactions ct
      JOIN cash_accounts a ON a.id = ct.account_id
      WHERE ct.deleted_at IS NULL
        AND ct.kind = 'income'
        AND ct.occurred_on >= ${from}::date
        AND ct.occurred_on <  ${toExcl}::date
      GROUP BY a.kind
    `)) as unknown as Array<{ kind: CashAccountKind; amountKopecks: string }>;
    const byKind: Record<CashAccountKind, string> = { cash: '0', bank: '0', card: '0' };
    for (const r of byKindRows) byKind[r.kind] = r.amountKopecks;

    return {
      incomeKopecks: income.toString(),
      expenseKopecks: expense.toString(),
      profitKopecks: (income - expense).toString(),
      incomeByKind: {
        cashKopecks: byKind.cash,
        cardKopecks: byKind.card,
        bankKopecks: byKind.bank,
      },
      expenseByCategory: byCat
        .filter((r) => r.kind === 'expense')
        .map((r) => ({ categoryId: r.categoryId, categoryName: r.categoryName, amountKopecks: r.amountKopecks })),
      incomeByCategory: byCat
        .filter((r) => r.kind === 'income')
        .map((r) => ({ categoryId: r.categoryId, categoryName: r.categoryName, amountKopecks: r.amountKopecks })),
    };
  });
}

export interface MonthlyFlowRow {
  /** 'YYYY-MM'. */
  month: string;
  incomeKopecks: string;
  expenseKopecks: string;
}

/** Помесячная динамика приход/расход за последние monthsBack месяцев (включая текущий). */
export async function getMonthlyFlow(
  db: Db,
  tenantId: string,
  monthsBack: number,
): Promise<MonthlyFlowRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        to_char(date_trunc('month', occurred_on), 'YYYY-MM') AS "month",
        COALESCE(SUM(amount_kopecks) FILTER (WHERE kind='income')::text, '0')  AS "incomeKopecks",
        COALESCE(SUM(amount_kopecks) FILTER (WHERE kind='expense')::text, '0') AS "expenseKopecks"
      FROM cash_transactions
      WHERE deleted_at IS NULL
        AND kind <> 'transfer'
        AND occurred_on >= (date_trunc('month', CURRENT_DATE) - make_interval(months => ${monthsBack - 1}::int))
      GROUP BY date_trunc('month', occurred_on)
      ORDER BY date_trunc('month', occurred_on) ASC
    `)) as unknown as MonthlyFlowRow[];
    return rows;
  });
}
