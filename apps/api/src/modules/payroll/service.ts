/** Сервис payroll — обёртка над repository с парсингом периода. */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import * as repo from './repository';
import { resolvePeriod, type PeriodPreset } from '../dashboard/service';
import { writeAudit } from '../../lib/audit';
import type { CmdCtx } from '../../trpc/helpers';

const PRESET_LABEL: Record<PeriodPreset['preset'], string> = {
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
  quarter: 'Квартал',
  custom: 'Период',
};

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toTrpc(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof Error) return new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Неизвестная ошибка' });
}

export async function getRuleQuery(db: Db, tenantId: string) {
  return repo.getRule(db, tenantId);
}

export async function setRuleCmd(db: Db, tenantId: string, input: repo.SetRuleInput) {
  return repo.setRule(db, tenantId, input);
}

export async function setEngineersSeeEarningsCmd(db: Db, tenantId: string, value: boolean) {
  return repo.setEngineersSeeEarnings(db, tenantId, value);
}

export async function computePayoutsQuery(
  db: Db,
  tenantId: string,
  input: PeriodPreset & { engineerId?: string | null },
) {
  const period = resolvePeriod(input);
  return repo.computePayouts(db, tenantId, period, {
    engineerId: input.engineerId ?? null,
  });
}

/* ────────────────────────── Выплаты ЗП ───────────────────────── */

export async function listPayoutsQuery(db: Db, tenantId: string, period: PeriodPreset) {
  const { start } = resolvePeriod(period);
  return repo.listPayouts(db, tenantId, dateOnly(start));
}

export interface CreatePayoutCmdInput {
  engineerId: string;
  kind: repo.PayoutKind;
  period: PeriodPreset;
  /** Сумма к выплате (с учётом ручной правки). */
  amountKopecks: bigint;
  paidOn: string;
  accountId: string;
  comment: string | null;
}

export async function createPayoutCmd(ctx: CmdCtx, input: CreatePayoutCmdInput) {
  const { start, end } = resolvePeriod(input.period);
  // Премия — отдельное поощрение, не из расчёта за период ⇒ computed = 0. Для аванса и
  // окончательного расчёта считаем начисление на сервере (для прозрачности ручной правки).
  let computedKopecks = 0n;
  if (input.kind !== 'bonus') {
    const computed = await repo.computePayouts(
      ctx.db,
      ctx.tenant.id,
      { start, end },
      {
        engineerId: input.engineerId,
      },
    );
    computedKopecks = BigInt(computed.rows[0]?.totalEarningsKopecks ?? '0');
  }

  let payout;
  try {
    payout = await repo.createPayout(ctx.db, ctx.tenant.id, {
      engineerId: input.engineerId,
      kind: input.kind,
      periodStart: dateOnly(start),
      periodEnd: dateOnly(end),
      periodLabel: PRESET_LABEL[input.period.preset],
      computedKopecks,
      amountKopecks: input.amountKopecks,
      paidOn: input.paidOn,
      accountId: input.accountId,
      comment: input.comment,
      createdBy: ctx.session.userId,
    });
  } catch (err) {
    throw toTrpc(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'payroll_payout',
    entityId: payout.id,
    after: {
      engineerId: payout.engineerId,
      kind: payout.kind,
      periodLabel: payout.periodLabel,
      amountKopecks: payout.amountKopecks,
      accountId: payout.accountId,
    },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return payout;
}

export interface UpdatePayoutCmdInput {
  amountKopecks?: bigint;
  paidOn?: string;
  accountId?: string;
  comment?: string | null;
}

export async function updatePayoutCmd(ctx: CmdCtx, id: string, patch: UpdatePayoutCmdInput) {
  let payout;
  try {
    payout = await repo.updatePayout(ctx.db, ctx.tenant.id, id, patch);
  } catch (err) {
    throw toTrpc(err);
  }
  if (!payout) throw new TRPCError({ code: 'NOT_FOUND', message: 'Выплата не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'payroll_payout',
    entityId: id,
    after: { amountKopecks: payout.amountKopecks, accountId: payout.accountId },
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return payout;
}

export async function deletePayoutCmd(ctx: CmdCtx, id: string) {
  const ok = await repo.deletePayout(ctx.db, ctx.tenant.id, id);
  if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Выплата не найдена' });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'payroll_payout',
    entityId: id,
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
  });
  return { ok: true };
}
