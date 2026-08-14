/**
 * Service журнала посещений: правила заполнения табеля + аудит.
 *
 * Правила здесь, а не в zod-схеме роутера, потому что часть из них смысловая, а не
 * формальная: «время бывает только у явки» и «явку нельзя поставить будущим днём»
 * — это про то, что табель фиксирует ФАКТ. Отпуск, больничный и выходной вперёд
 * ставить можно: их планируют заранее.
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import {
  deleteRecord as repoDeleteRecord,
  listEmployees as repoListEmployees,
  listRecords as repoListRecords,
  upsertRecord as repoUpsertRecord,
  userExists,
  type AttendanceEmployeeDto,
  type AttendanceRecordDto,
  type AttendanceStatus,
} from './repository';

export interface MonthRange {
  /** YYYY-MM-DD, первое число месяца */
  from: string;
  /** YYYY-MM-DD, последнее число месяца */
  to: string;
}

/** Границы месяца как строки дат — без часовых поясов и Date-арифметики. */
export function monthRange(year: number, month: number): MonthRange {
  const mm = String(month).padStart(2, '0');
  // Date.UTC(y, m, 0) — «нулевой день» следующего месяца = последний день текущего.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Сегодня в таймзоне организации. Табель ведут по местному времени, и «завтра»
 * должно наступать вместе с ним, а не по UTC.
 */
export function todayInTimezone(timezone: string, now: Date = new Date()): string {
  try {
    // en-CA даёт ровно YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export interface AttendanceMonthDto {
  from: string;
  to: string;
  employees: AttendanceEmployeeDto[];
  records: AttendanceRecordDto[];
}

export async function monthQuery(
  db: Db,
  tenant: ResolvedTenant,
  input: { year: number; month: number },
): Promise<AttendanceMonthDto> {
  const range = monthRange(input.year, input.month);
  const records = await repoListRecords(db, tenant.id, range);
  const employees = await repoListEmployees(db, tenant.id, [
    ...new Set(records.map((r) => r.userId)),
  ]);
  return { ...range, employees, records };
}

export interface UpsertInput {
  userId: string;
  workDate: string;
  status: AttendanceStatus;
  arrivedAt?: string | null;
  leftAt?: string | null;
  note?: string | null;
}

export async function upsertCmd(ctx: CmdCtx, input: UpsertInput): Promise<{ id: string }> {
  const arrivedAt = input.arrivedAt ?? null;
  const leftAt = input.leftAt ?? null;

  if (!(await userExists(ctx.db, ctx.tenant.id, input.userId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Сотрудник не найден' });
  }

  if (input.status !== 'present' && (arrivedAt || leftAt)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Время прихода и ухода бывает только у явки',
    });
  }

  if (leftAt && !arrivedAt) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Сначала укажите время прихода',
    });
  }

  if (arrivedAt && leftAt && leftAt <= arrivedAt) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Уход должен быть позже прихода',
    });
  }

  // Явка — это факт, а не план: завтрашним днём её не ставят. Отпуск, больничный,
  // командировку и выходной вперёд отмечать можно, их и планируют заранее.
  if (input.status === 'present' && input.workDate > todayInTimezone(ctx.tenant.timezone)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Явку нельзя отметить будущим днём — журнал фиксирует факт',
    });
  }

  const result = await repoUpsertRecord(ctx.db, ctx.tenant.id, {
    userId: input.userId,
    workDate: input.workDate,
    status: input.status,
    arrivedAt,
    leftAt,
    note: input.note?.trim() ? input.note.trim() : null,
  });

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: result.created ? 'create' : 'update',
    entityType: 'attendance_record',
    entityId: result.id,
    after: {
      userId: input.userId,
      workDate: input.workDate,
      status: input.status,
      arrivedAt,
      leftAt,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });

  return { id: result.id };
}

export async function removeCmd(
  ctx: CmdCtx,
  input: { userId: string; workDate: string },
): Promise<{ removed: boolean }> {
  const id = await repoDeleteRecord(ctx.db, ctx.tenant.id, input);
  if (!id) return { removed: false };

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'attendance_record',
    entityId: id,
    before: { userId: input.userId, workDate: input.workDate },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });

  return { removed: true };
}
