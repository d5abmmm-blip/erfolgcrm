/**
 * Service кассы (ДДС). Query — тонкие обёртки над repository; Cmd — пишут audit
 * и оборачивают бизнес-ошибки repository в TRPCError (паттерн payments/service).
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import * as repo from './repository';

/* ─────────────────────────── Период ──────────────────────────── */

export type PeriodPreset = 'today' | 'week' | 'month' | 'quarter' | 'year';

/** Пресет периода → [start, end) в UTC. Границы по UTC (не зависят от tz сервера). */
export function resolvePeriod(preset: PeriodPreset): repo.PeriodInput {
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(startOfToday);
  end.setUTCDate(end.getUTCDate() + 1); // конец = завтра 00:00 UTC (сегодня включительно)

  switch (preset) {
    case 'today':
      return { start: startOfToday, end };
    case 'week': {
      const start = new Date(startOfToday);
      start.setUTCDate(start.getUTCDate() - 6);
      return { start, end };
    }
    case 'month':
      return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end };
    case 'quarter': {
      const q = Math.floor(now.getUTCMonth() / 3);
      return { start: new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1)), end };
    }
    case 'year':
      return { start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), end };
  }
}

const DAY_MS = 86_400_000;

/**
 * Предыдущий сопоставимый период — для строчки «+12% к прошлому месяцу».
 *
 * Сегодня/неделя — просто сдвигаем окно на его длину назад (вчера / прошлые 7 дней).
 *
 * Месяц/квартал/год — сравниваем с ТЕМ ЖЕ отрезком предыдущего месяца/квартала/года
 * (1–15 июля ↔ 1–15 июня), а не с равным куском, перетекающим через границу месяца:
 * иначе «месяц к месяцу» сравнивал бы 1–15 июля с 16–30 июня, и цифра врала бы.
 *
 * Отрезок обрезаем по длине предыдущей единицы: 31 марта сравнивать не с чем (31 февраля
 * не бывает) → берём февраль целиком.
 */
export function resolvePreviousPeriod(
  preset: PeriodPreset,
  current: repo.PeriodInput,
): repo.PeriodInput {
  const elapsedDays = Math.round((current.end.getTime() - current.start.getTime()) / DAY_MS);

  if (preset === 'today' || preset === 'week') {
    const shift = elapsedDays * DAY_MS;
    return {
      start: new Date(current.start.getTime() - shift),
      end: new Date(current.end.getTime() - shift),
    };
  }

  const y = current.start.getUTCFullYear();
  const m = current.start.getUTCMonth();
  const prevStart =
    preset === 'month'
      ? new Date(Date.UTC(y, m - 1, 1))
      : preset === 'quarter'
        ? new Date(Date.UTC(y, m - 3, 1))
        : new Date(Date.UTC(y - 1, 0, 1));

  // Сколько дней в предыдущей единице (месяц/квартал/год) — чтобы не выйти за её границу.
  const unitDays = Math.round((current.start.getTime() - prevStart.getTime()) / DAY_MS);
  const span = Math.min(elapsedDays, unitDays);
  return { start: prevStart, end: new Date(prevStart.getTime() + span * DAY_MS) };
}

/* ─────────────────────────── Счета ───────────────────────────── */

export function listAccountsQuery(db: Db, tenant: ResolvedTenant, includeArchived: boolean) {
  return repo.listAccounts(db, tenant.id, { includeArchived });
}

export async function createAccountCmd(ctx: CmdCtx, input: repo.CreateAccountInput) {
  let account;
  try {
    account = await repo.createAccount(ctx.db, ctx.tenant.id, input);
  } catch (err) {
    throw toTrpc(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'cash_account',
    entityId: account.id,
    after: { name: account.name, kind: account.kind, openingBalanceKopecks: account.openingBalanceKopecks },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return account;
}

export async function updateAccountCmd(
  ctx: CmdCtx,
  id: string,
  patch: repo.UpdateAccountInput,
) {
  let account;
  try {
    account = await repo.updateAccount(ctx.db, ctx.tenant.id, id, patch);
  } catch (err) {
    throw toTrpc(err);
  }
  if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Счёт не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'cash_account',
    entityId: id,
    after: { ...patch, openingBalanceKopecks: patch.openingBalanceKopecks?.toString() },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return account;
}

export async function deleteAccountCmd(ctx: CmdCtx, id: string) {
  const result = await repo.deleteAccount(ctx.db, ctx.tenant.id, id);
  if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'Счёт не найден' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: result === 'deleted' ? 'delete' : 'update',
    entityType: 'cash_account',
    entityId: id,
    after: { result },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { result };
}

/* ─────────────────────────── Статьи ──────────────────────────── */

export function listCategoriesQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: { direction?: repo.CashDirection; includeArchived?: boolean },
) {
  return repo.listCategories(db, tenant.id, opts);
}

export async function createCategoryCmd(
  ctx: CmdCtx,
  input: { name: string; direction: repo.CashDirection },
) {
  const category = await repo.createCategory(ctx.db, ctx.tenant.id, input);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'cash_category',
    entityId: category.id,
    after: { name: category.name, direction: category.direction },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return category;
}

export async function updateCategoryCmd(
  ctx: CmdCtx,
  id: string,
  patch: { name?: string; isArchived?: boolean; sortOrder?: number },
) {
  const category = await repo.updateCategory(ctx.db, ctx.tenant.id, id, patch);
  if (!category) throw new TRPCError({ code: 'NOT_FOUND', message: 'Статья не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'cash_category',
    entityId: id,
    after: patch,
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return category;
}

/* ────────────────────────── Операции ─────────────────────────── */

export function listTransactionsQuery(
  db: Db,
  tenant: ResolvedTenant,
  filter: repo.TransactionFilter,
  limit: number,
  offset: number,
) {
  return repo.listTransactions(db, tenant.id, filter, limit, offset);
}

/** Внутренняя операция кассы: внесение/выдача — не доход/расход бизнеса. */
export async function createInternalCmd(
  ctx: CmdCtx,
  input: Omit<repo.CreateInternalOpInput, 'userId'>,
) {
  let result;
  try {
    result = await repo.createInternalOp(ctx.db, ctx.tenant.id, {
      ...input,
      userId: ctx.session.userId,
    });
  } catch (err) {
    throw toTrpc(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'cash_transaction',
    entityId: result.id,
    after: {
      internal: input.kind,
      accountId: input.accountId,
      amountKopecks: input.amountKopecks.toString(),
    },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function createTransactionCmd(ctx: CmdCtx, input: repo.CreateTransactionInput) {
  let result;
  try {
    result = await repo.createTransaction(ctx.db, ctx.tenant.id, input);
  } catch (err) {
    throw toTrpc(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'cash_transaction',
    entityId: result.id,
    after: {
      kind: input.kind,
      accountId: input.accountId,
      counterAccountId: input.counterAccountId ?? null,
      categoryId: input.categoryId ?? null,
      amountKopecks: input.amountKopecks.toString(),
    },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return result;
}

export async function deleteTransactionCmd(ctx: CmdCtx, id: string) {
  const ok = await repo.deleteTransaction(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Операция не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'cash_transaction',
    entityId: id,
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}

/* ────────────────────────── Обзор ────────────────────────────── */

export interface CashOverview {
  balances: repo.AccountBalancesReport;
  summary: repo.PeriodSummary;
  /** Тот же расчёт за предыдущий сопоставимый период — для дельты «+12% к прошлому месяцу». */
  previous: repo.PeriodSummary;
  monthly: repo.MonthlyFlowRow[];
  recent: repo.CashTransactionDto[];
  period: { start: string; end: string };
  previousPeriod: { start: string; end: string };
}

/** Всё для страницы «Обзор» одним вызовом. */
export async function overviewQuery(
  db: Db,
  tenant: ResolvedTenant,
  preset: PeriodPreset,
  includeInternal = false,
): Promise<CashOverview> {
  const period = resolvePeriod(preset);
  const prevPeriod = resolvePreviousPeriod(preset, period);
  const [balances, summary, previous, monthly, recent] = await Promise.all([
    repo.getAccountBalances(db, tenant.id),
    repo.getPeriodSummary(db, tenant.id, period, includeInternal),
    // Тот же агрегат, просто другое окно дат — нового SQL не нужно.
    repo.getPeriodSummary(db, tenant.id, prevPeriod, includeInternal),
    repo.getMonthlyFlow(db, tenant.id, 6, includeInternal),
    repo.listTransactions(db, tenant.id, {}, 8, 0).then((r) => r.items),
  ]);
  return {
    balances,
    summary,
    previous,
    monthly,
    recent,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    previousPeriod: {
      start: prevPeriod.start.toISOString(),
      end: prevPeriod.end.toISOString(),
    },
  };
}

/* ────────────────────────── helpers ──────────────────────────── */

function toTrpc(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof Error) return new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Неизвестная ошибка' });
}
