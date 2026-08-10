/**
 * Ручная ведомость выплат по сотрудникам (payroll_sheets).
 *
 * Отдельный учётный журнал: директор вручную вбивает оклад/аванс/премию по месяцам.
 * Кассу (ДДС) НЕ трогает — в отличие от выплат (payroll_payouts).
 *
 * Перезапись существующей ведомости за месяц — только с причиной (≥10 симв.), пишем
 * old/new diff в audit_logs (402-ФЗ ст.10). Удаление — мягкое (deleted_at), после чего
 * месяц можно завести заново. Всё директор-only (гейт на уровне роутера).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  cashAccounts,
  cashCategories,
  cashTransactions,
  payrollSheets,
  withTenantTx,
  type Db,
  type PayrollSheet,
  type PayrollSheetEntry,
} from '@erfolg/db';
import { recalcAccountsInTx } from '../cash/repository';
import { writeAuditInTx } from '../../lib/audit';
import type { CmdCtx } from '../../trpc/helpers';

type Tx = Parameters<Parameters<typeof withTenantTx>[2]>[0];

const MONTHS_RU = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];
function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  const idx = Number(m) - 1;
  return `${MONTHS_RU[idx] ?? m} ${y}`;
}

/**
 * Итог к выплате по ведомости = начислено (оклад + сделка + премия) МИНУС аванс,
 * НО не меньше нуля ПО КАЖДОМУ сотруднику. Аванс — уже выданные деньги, поэтому
 * он уменьшает остаток к доплате; а если аванс превысил начисление — это ДОЛГ
 * человека, а не скидка на зарплату остальных: отрицательный остаток одного
 * раньше уменьшал сумму проводки, и касса записывала меньше, чем реально
 * выдадут людям. В кассу проводится сумма положительных остатков — сам аванс
 * уходил из кассы раньше, отдельным расходом.
 */
function sheetTotalKopecks(entries: PayrollSheetEntry[]): bigint {
  let t = 0;
  for (const e of entries) {
    const person =
      (e.salaryKopecks ?? 0) +
      (e.pieceworkKopecks ?? 0) +
      (e.bonusKopecks ?? 0) -
      (e.advanceKopecks ?? 0);
    t += Math.max(0, person);
  }
  return BigInt(Math.round(t));
}

/** Статья расхода «Зарплата» — найти или создать (как у выплат). */
async function ensureSalaryCategory(tx: Tx, tenantId: string): Promise<string> {
  const existing = await tx
    .select({ id: cashCategories.id })
    .from(cashCategories)
    .where(
      and(
        eq(cashCategories.tenantId, tenantId),
        eq(cashCategories.direction, 'expense'),
        eq(cashCategories.name, 'Зарплата'),
        isNull(cashCategories.deletedAt),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await tx
    .insert(cashCategories)
    .values({ tenantId, name: 'Зарплата', direction: 'expense', isSystem: true })
    .returning({ id: cashCategories.id });
  return inserted[0]!.id;
}

export interface PayrollSheetDto {
  id: string;
  /** Месяц ведомости, YYYY-MM. */
  month: string;
  entries: PayrollSheetEntry[];
  /** Когда сохранено (updated_at), ISO. */
  savedAt: string;
  /** Проведение в кассу: если проведена — ссылка на расход и сумма/счёт/время. */
  cashTransactionId: string | null;
  postedAmountKopecks: string | null;
  postedAccountId: string | null;
  postedAt: string | null;
}

function toDto(row: PayrollSheet): PayrollSheetDto {
  return {
    id: row.id,
    month: row.month,
    entries: row.entries ?? [],
    savedAt: row.updatedAt.toISOString(),
    cashTransactionId: row.cashTransactionId ?? null,
    postedAmountKopecks:
      row.postedAmountKopecks != null ? row.postedAmountKopecks.toString() : null,
    postedAccountId: row.postedAccountId ?? null,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
  };
}

export interface SaveSheetInput {
  month: string; // YYYY-MM
  entries: PayrollSheetEntry[];
  reason?: string;
}

/** Список всех живых ведомостей (для годовой сводки), новые месяцы сверху. */
export async function listSheets(db: Db, tenantId: string): Promise<PayrollSheetDto[]> {
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select()
      .from(payrollSheets)
      .where(isNull(payrollSheets.deletedAt))
      .orderBy(desc(payrollSheets.month)),
  );
  return rows.map(toDto);
}

/** Ведомость за конкретный месяц (или null). */
export async function getSheetByMonth(
  db: Db,
  tenantId: string,
  month: string,
): Promise<PayrollSheetDto | null> {
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select()
      .from(payrollSheets)
      .where(and(eq(payrollSheets.month, month), isNull(payrollSheets.deletedAt)))
      .limit(1),
  );
  return rows[0] ? toDto(rows[0]) : null;
}

/**
 * Сохранить ведомость за месяц. Если живая ведомость за месяц уже есть — перезапись
 * (требуется reason ≥10 симв.) с записью diff в audit. Иначе — вставка. Мутация + аудит
 * атомарны (одна tenant-транзакция).
 */
export async function saveSheet(ctx: CmdCtx, input: SaveSheetInput): Promise<PayrollSheetDto> {
  const tenantId = ctx.tenant.id;
  return withTenantTx(ctx.db, tenantId, async (tx) => {
    const existing = (
      await tx
        .select()
        .from(payrollSheets)
        .where(and(eq(payrollSheets.month, input.month), isNull(payrollSheets.deletedAt)))
        .limit(1)
    )[0];

    if (existing) {
      // Перезапись бух-документа — только с причиной (402-ФЗ ст.10).
      if (!input.reason || input.reason.trim().length < 10) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Ведомость за этот месяц уже сохранена. Для перезаписи укажите причину (минимум 10 символов).',
        });
      }
      const updated = (
        await tx
          .update(payrollSheets)
          .set({ entries: input.entries, createdBy: ctx.session.userId })
          .where(eq(payrollSheets.id, existing.id))
          .returning()
      )[0]!;
      await writeAuditInTx(tx, tenantId, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'payroll_sheet',
        entityId: existing.id,
        before: { month: existing.month, entries: existing.entries },
        after: { month: updated.month, entries: updated.entries },
        context: { reason: input.reason.trim() },
        ip: ctx.audit.ip,
        userAgent: ctx.audit.userAgent,
      });
      return toDto(updated);
    }

    const inserted = (
      await tx
        .insert(payrollSheets)
        .values({
          tenantId,
          month: input.month,
          entries: input.entries,
          createdBy: ctx.session.userId,
        })
        .returning()
    )[0]!;
    await writeAuditInTx(tx, tenantId, {
      userId: ctx.session.userId,
      action: 'create',
      entityType: 'payroll_sheet',
      entityId: inserted.id,
      after: { month: inserted.month, entries: inserted.entries },
      ip: ctx.audit.ip,
      userAgent: ctx.audit.userAgent,
    });
    return toDto(inserted);
  });
}

/** Мягко удалить ведомость за месяц (+ audit). */
export async function deleteSheet(ctx: CmdCtx, month: string): Promise<{ ok: true }> {
  const tenantId = ctx.tenant.id;
  return withTenantTx(ctx.db, tenantId, async (tx) => {
    const existing = (
      await tx
        .select()
        .from(payrollSheets)
        .where(and(eq(payrollSheets.month, month), isNull(payrollSheets.deletedAt)))
        .limit(1)
    )[0];
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Ведомость не найдена' });
    }
    // Если ведомость была проведена в кассу — убираем связанный расход и пересчитываем счёт.
    if (existing.cashTransactionId) {
      await tx
        .update(cashTransactions)
        .set({ deletedAt: new Date() })
        .where(eq(cashTransactions.id, existing.cashTransactionId));
      if (existing.postedAccountId) {
        await recalcAccountsInTx(tx, tenantId, [existing.postedAccountId]);
      }
    }
    await tx
      .update(payrollSheets)
      .set({ deletedAt: new Date() })
      .where(eq(payrollSheets.id, existing.id));
    await writeAuditInTx(tx, tenantId, {
      userId: ctx.session.userId,
      action: 'delete',
      entityType: 'payroll_sheet',
      entityId: existing.id,
      before: { month: existing.month, entries: existing.entries },
      ip: ctx.audit.ip,
      userAgent: ctx.audit.userAgent,
    });
    return { ok: true };
  });
}

/**
 * Провести ведомость за месяц в кассу: сумма ведомости (оклад+сделка+премия−аванс по всем)
 * становится расходом (статья «Зарплата»), остаток счёта уменьшается. Идемпотентно —
 * повторное проведение (после правки) снимает прежний расход и создаёт новый.
 */
export async function postToCash(
  ctx: CmdCtx,
  month: string,
  accountId: string,
): Promise<PayrollSheetDto> {
  const tenantId = ctx.tenant.id;
  return withTenantTx(ctx.db, tenantId, async (tx) => {
    // FOR UPDATE: два директора могли нажать «Провести» одновременно. Без
    // замка оба видели ведомость непроведённой, каждый вставлял расход —
    // в кассе оказывалось ДВА расхода на всю зарплату, а «Отменить
    // проведение» убирал только один (ссылку пережил последний писатель).
    // С замком второй ждёт первого, видит его расход и перепроводит.
    const sheet = (
      await tx
        .select()
        .from(payrollSheets)
        .where(and(eq(payrollSheets.month, month), isNull(payrollSheets.deletedAt)))
        .for('update')
        .limit(1)
    )[0];
    if (!sheet) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Сначала сохраните ведомость за этот месяц',
      });
    }
    const total = sheetTotalKopecks(sheet.entries ?? []);
    if (total <= 0n) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Нечего проводить: сумма ведомости — 0',
      });
    }

    const acc = (
      await tx
        .select({ id: cashAccounts.id })
        .from(cashAccounts)
        .where(
          and(
            eq(cashAccounts.tenantId, tenantId),
            eq(cashAccounts.id, accountId),
            isNull(cashAccounts.deletedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!acc) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Денежный счёт не найден' });

    const affected = new Set<string>();
    // Уже проведена — снимаем прежний расход (перепроведение с новой суммой/счётом).
    if (sheet.cashTransactionId) {
      await tx
        .update(cashTransactions)
        .set({ deletedAt: new Date() })
        .where(eq(cashTransactions.id, sheet.cashTransactionId));
      if (sheet.postedAccountId) affected.add(sheet.postedAccountId);
    }

    const categoryId = await ensureSalaryCategory(tx, tenantId);
    const cashRow = (
      await tx
        .insert(cashTransactions)
        .values({
          tenantId,
          kind: 'expense',
          accountId,
          categoryId,
          amountKopecks: total,
          occurredOn: `${month}-01`,
          comment: `Зарплата за ${monthLabel(month)}`,
          userId: ctx.session.userId,
          source: 'manual',
        })
        .returning({ id: cashTransactions.id })
    )[0]!;
    affected.add(accountId);
    await recalcAccountsInTx(tx, tenantId, Array.from(affected));

    const updated = (
      await tx
        .update(payrollSheets)
        .set({
          cashTransactionId: cashRow.id,
          postedAmountKopecks: total,
          postedAccountId: accountId,
          postedAt: new Date(),
        })
        .where(eq(payrollSheets.id, sheet.id))
        .returning()
    )[0]!;

    await writeAuditInTx(tx, tenantId, {
      userId: ctx.session.userId,
      action: 'update',
      entityType: 'payroll_sheet',
      entityId: sheet.id,
      context: { posted: true, month, amountKopecks: total.toString(), accountId },
      ip: ctx.audit.ip,
      userAgent: ctx.audit.userAgent,
    });
    return toDto(updated);
  });
}

/** Отменить проведение: убрать расход из кассы, вернуть остаток, снять отметку. */
export async function unpostFromCash(ctx: CmdCtx, month: string): Promise<PayrollSheetDto> {
  const tenantId = ctx.tenant.id;
  return withTenantTx(ctx.db, tenantId, async (tx) => {
    // FOR UPDATE — тот же замок, что у postToCash, и берётся ПЕРВЫМ в обеих
    // функциях (одинаковый порядок = нет взаимной блокировки): «Провести» и
    // «Отменить» параллельно теперь выстраиваются в очередь, а не рвут ссылку.
    const sheet = (
      await tx
        .select()
        .from(payrollSheets)
        .where(and(eq(payrollSheets.month, month), isNull(payrollSheets.deletedAt)))
        .for('update')
        .limit(1)
    )[0];
    if (!sheet) throw new TRPCError({ code: 'NOT_FOUND', message: 'Ведомость не найдена' });
    if (!sheet.cashTransactionId) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Ведомость не проведена в кассу',
      });
    }
    await tx
      .update(cashTransactions)
      .set({ deletedAt: new Date() })
      .where(eq(cashTransactions.id, sheet.cashTransactionId));
    if (sheet.postedAccountId) {
      await recalcAccountsInTx(tx, tenantId, [sheet.postedAccountId]);
    }
    const updated = (
      await tx
        .update(payrollSheets)
        .set({
          cashTransactionId: null,
          postedAmountKopecks: null,
          postedAccountId: null,
          postedAt: null,
        })
        .where(eq(payrollSheets.id, sheet.id))
        .returning()
    )[0]!;
    await writeAuditInTx(tx, tenantId, {
      userId: ctx.session.userId,
      action: 'update',
      entityType: 'payroll_sheet',
      entityId: sheet.id,
      context: { posted: false, month },
      ip: ctx.audit.ip,
      userAgent: ctx.audit.userAgent,
    });
    return toDto(updated);
  });
}
