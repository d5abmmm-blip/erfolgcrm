/**
 * Service слой для ticket_templates.
 *
 * Бизнес-логика:
 *   - apply(ticketId, templateId): обновляет тикет дефолтами шаблона (только non-null
 *     поля), создаёт work_order (если ещё нет) и заливает в него строки из шаблона.
 *     Цены без значения (unitPriceRub === null) идут как 0 — менеджер дозаполнит вручную.
 *   - audit:
 *       create/update/archive/unarchive — обычные create/update/delete/restore.
 *       apply — пишем как create entityType='ticket_template_apply', entityId=ticketId,
 *               чтобы в /settings/audit это легко фильтровалось.
 */
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { tickets, withTenantTx } from '@erfolg/db';
import type { RepairType, TicketPriority } from '@erfolg/shared';
import { writeAudit } from '../../lib/audit';
import { toTRPCError, TicketNotFoundError } from '../../lib/errors';
import {
  archiveTemplate as repoArchive,
  createTemplate as repoCreate,
  getActiveTemplateOrThrow,
  getTemplate as repoGet,
  listTemplates as repoList,
  unarchiveTemplate as repoUnarchive,
  updateTemplate as repoUpdate,
  type CreateTemplateInput,
  type TicketTemplateDto,
  type UpdateTemplateInput,
} from './repository';
import {
  getOrCreateWorkOrder,
  upsertLine as repoUpsertLine,
} from '../work-orders/repository';
import {
  getTicket as repoGetTicket,
  updateTicket as repoUpdateTicket,
} from '../tickets/repository';
import type { CmdCtx } from '../../trpc/helpers';

export interface ListOpts {
  includeArchived?: boolean;
}

export async function listTemplatesQuery(
  ctx: CmdCtx,
  opts: ListOpts = {},
): Promise<TicketTemplateDto[]> {
  return repoList(ctx.db, ctx.tenant.id, opts);
}

export async function getTemplateQuery(
  ctx: CmdCtx,
  id: string,
): Promise<TicketTemplateDto> {
  const tpl = await repoGet(ctx.db, ctx.tenant.id, id);
  if (!tpl) throw new TRPCError({ code: 'NOT_FOUND', message: 'Шаблон не найден' });
  return tpl;
}

export async function createTemplateCmd(
  ctx: CmdCtx,
  input: Omit<CreateTemplateInput, 'createdByUserId'>,
): Promise<TicketTemplateDto> {
  let tpl: TicketTemplateDto;
  try {
    tpl = await repoCreate(ctx.db, ctx.tenant.id, {
      ...input,
      createdByUserId: ctx.session.userId,
    });
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'ticket_template',
    entityId: tpl.id,
    after: { name: tpl.name, linesCount: tpl.linesCount },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return tpl;
}

export async function updateTemplateCmd(
  ctx: CmdCtx,
  id: string,
  patch: UpdateTemplateInput,
): Promise<TicketTemplateDto> {
  let tpl: TicketTemplateDto;
  try {
    tpl = await repoUpdate(ctx.db, ctx.tenant.id, id, patch);
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket_template',
    entityId: id,
    after: {
      patchKeys: Object.keys(patch),
      linesCount: tpl.linesCount,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return tpl;
}

export async function archiveTemplateCmd(
  ctx: CmdCtx,
  id: string,
): Promise<TicketTemplateDto> {
  let tpl: TicketTemplateDto;
  try {
    tpl = await repoArchive(ctx.db, ctx.tenant.id, id);
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    // Семантически — soft delete.
    action: 'delete',
    entityType: 'ticket_template',
    entityId: id,
    after: { archivedAt: tpl.archivedAt },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return tpl;
}

export async function unarchiveTemplateCmd(
  ctx: CmdCtx,
  id: string,
): Promise<TicketTemplateDto> {
  let tpl: TicketTemplateDto;
  try {
    tpl = await repoUnarchive(ctx.db, ctx.tenant.id, id);
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'restore',
    entityType: 'ticket_template',
    entityId: id,
    after: { archivedAt: null },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return tpl;
}

export interface ApplyResult {
  ticketId: string;
  workOrderId: string;
  /** Сколько строк добавлено в наряд. */
  linesAdded: number;
  /** Применённые шаблоном дефолты (для UI-toast). */
  appliedDefaults: {
    repairType: boolean;
    priority: boolean;
    estimatedMinutes: boolean;
  };
}

interface TicketDefaultsPatch {
  repairType?: RepairType;
  priority?: TicketPriority;
}

/**
 * Применить шаблон к существующему тикету.
 *
 * Алгоритм:
 *   1. Загружаем тикет (RLS гарантирует tenant) и активный шаблон.
 *   2. Если в шаблоне заданы default_*, обновляем тикет через стандартный update
 *      (он же создаёт ticket_event-ы про priority_change и пр.).
 *   3. ensureWorkOrder + upsertLine для каждой строки шаблона. Используем
 *      существующий repoUpsertLine, чтобы автоматически получить корректный
 *      пересчёт totals и cost-snapshot.
 *   4. Отдельная audit-запись (entityType='ticket_template_apply') — для filtering
 *      в журнале действий.
 */
export async function applyTemplateCmd(
  ctx: CmdCtx,
  input: { ticketId: string; templateId: string },
): Promise<ApplyResult> {
  const ticket = await repoGetTicket(ctx.db, ctx.tenant.id, input.ticketId);
  if (!ticket) throw toTRPCError(new TicketNotFoundError());

  let tpl: TicketTemplateDto;
  try {
    tpl = await getActiveTemplateOrThrow(ctx.db, ctx.tenant.id, input.templateId);
  } catch (err) {
    throw toTRPCError(err);
  }

  // 2. Дефолты тикета. Обновляем только то, что задано в шаблоне.
  const ticketPatch: TicketDefaultsPatch = {};
  const appliedDefaults: ApplyResult['appliedDefaults'] = {
    repairType: false,
    priority: false,
    estimatedMinutes: false,
  };
  if (tpl.defaultRepairType) {
    ticketPatch.repairType = tpl.defaultRepairType;
    appliedDefaults.repairType = true;
  }
  if (tpl.defaultPriority) {
    ticketPatch.priority = tpl.defaultPriority;
    appliedDefaults.priority = true;
  }
  if (Object.keys(ticketPatch).length > 0) {
    await repoUpdateTicket(
      ctx.db,
      ctx.tenant.id,
      ctx.session.userId,
      input.ticketId,
      ticketPatch,
    );
  }
  // estimated_minutes — это поле расписания (Stage 11). Перезаписываем только если
  // тикет ещё не запланирован, чтобы не сломать существующий график инженера.
  if (
    tpl.defaultEstimatedMinutes &&
    ticket.scheduledStartAt === null &&
    ticket.estimatedMinutes === null
  ) {
    await withTenantTx(ctx.db, ctx.tenant.id, (tx) =>
      tx
        .update(tickets)
        .set({ estimatedMinutes: tpl.defaultEstimatedMinutes })
        .where(eq(tickets.id, input.ticketId)),
    );
    appliedDefaults.estimatedMinutes = true;
  }

  // 3. Наряд + строки.
  const wo = await getOrCreateWorkOrder(ctx.db, ctx.tenant.id, input.ticketId);
  const baseOrderIdx = wo.lines.length;
  let linesAdded = 0;
  for (let i = 0; i < tpl.lines.length; i += 1) {
    const line = tpl.lines[i];
    if (!line) continue;
    const unitPriceKopecks =
      line.unitPriceRub !== null && line.unitPriceRub > 0
        ? BigInt(Math.round(line.unitPriceRub)) * 100n
        : 0n;
    await repoUpsertLine(ctx.db, ctx.tenant.id, wo.id, null, {
      lineType: line.lineType,
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      unitPriceKopecks,
      engineerId: null,
      comment: null,
      orderIdx: baseOrderIdx + i,
    });
    linesAdded += 1;
  }

  // 4. Audit — одна запись на apply, не по строке.
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'ticket_template_apply',
    entityId: input.ticketId,
    after: {
      templateId: tpl.id,
      templateName: tpl.name,
      workOrderId: wo.id,
      linesAdded,
      appliedDefaults,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });

  return {
    ticketId: input.ticketId,
    workOrderId: wo.id,
    linesAdded,
    appliedDefaults,
  };
}

/** Re-export DTO для использования в роутере и тестах. */
export type { TicketTemplateDto } from './repository';
