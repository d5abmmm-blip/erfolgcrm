/**
 * Service слой для tickets.
 *
 * Бизнес-инвариант: каждое значимое изменение → ticket_event + AuditLog.
 * Чувствительные тексты (symptom, notes, cancelReason) НЕ кладутся в audit
 * after — только метаданные изменения (ключи, статусы).
 */
import { TRPCError } from '@trpc/server';
import type { TicketStatus, TicketBlockedReason } from '@erfolg/shared';
import { withTenantTx, type Db } from '@erfolg/db';
import { writeAudit, writeAuditInTx } from '../../lib/audit';
import { toTRPCError } from '../../lib/errors';
import { assertContractInTenant } from '../contracts';
import { getClientQuery } from '../clients/service';
import { checkAttestationForAssignment } from '../attestations';
import { enqueuePushToUser } from '../notifications';
import { logger } from '../../lib/logger';
import {
  addNote as repoAddNote,
  assetBelongsToTenant,
  boardTickets as repoBoardTickets,
  changeStatus as repoChangeStatus,
  clientBelongsToTenant,
  clientSubtype,
  createTicket as repoCreateTicket,
  getAssetRequiredAttestation,
  getOrCreateTrackToken as repoGetOrCreateTrackToken,
  getTicket as repoGetTicket,
  listEvents as repoListEvents,
  listHelperTicketIds as repoListHelperTicketIds,
  listTicketEngineers as repoListTicketEngineers,
  setTicketEngineers as repoSetTicketEngineers,
  revokeTrackToken as repoRevokeTrackToken,
  listTickets as repoListTickets,
  partsWaitingList as repoPartsWaitingList,
  recordPrintEvent as repoRecordPrint,
  setBlockedReason as repoSetBlockedReason,
  setWaitingForPart as repoSetWaitingForPart,
  repoMyWeeklySchedule,
  repoSchedule,
  repoUnschedule,
  repoWeeklySchedule,
  searchTickets as repoSearchTickets,
  softDeleteTicket as repoSoftDeleteTicket,
  updateTicket as repoUpdateTicket,
  userBelongsToTenant,
  type BoardTicketDto,
  type CreateTicketInput,
  type ListTicketsOpts,
  type PartWaitingItem,
  type ScheduledTicketDto,
  type UpdateTicketInput,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import { clearUnansweredCount, snoozeAsk } from '../../lib/nudge-state';
import { assertWorkOrderEditable } from '../work-orders/edit-window';

async function ensureRefsExist(
  db: Db,
  tenantId: string,
  refs: {
    clientId?: string;
    assetId?: string | null;
    dispatcherId?: string | null;
    engineerId?: string | null;
    contractId?: string | null;
  },
): Promise<void> {
  if (refs.clientId) {
    const ok = await clientBelongsToTenant(db, tenantId, refs.clientId);
    if (!ok) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Клиент не найден в tenant' });
  }
  if (refs.assetId) {
    const ok = await assetBelongsToTenant(db, tenantId, refs.assetId);
    if (!ok) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Техника не найдена в tenant' });
  }
  if (refs.dispatcherId) {
    const ok = await userBelongsToTenant(db, tenantId, refs.dispatcherId);
    if (!ok) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Диспетчер не найден в tenant' });
  }
  if (refs.engineerId) {
    const ok = await userBelongsToTenant(db, tenantId, refs.engineerId);
    if (!ok) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Инженер не найден в tenant' });
  }
  if (refs.contractId) {
    await assertContractInTenant(db, tenantId, refs.contractId);
  }
}

/**
 * Контракт у бюджетной организации — ПРЕДУПРЕЖДЕНИЕ, а не запрет (решение владельца
 * 2026-07-23). Возвращает текст плашки или null; создание/сохранение НЕ блокирует.
 *
 * ⚠️ РАНЬШЕ ЗДЕСЬ БЫЛ ЗАПРЕТ (44-ФЗ), и он закрывал работу. По боевым данным:
 * госучреждений 122, договоров заведено 0 (ни одного), их заявок 4589 = 76,5 % всей
 * работы — и все без контракта, они приехали из старой программы. То есть менеджер
 * не мог завести заявку НИ ОДНОМУ госучреждению. Сам контракт при этом дальше нигде
 * не используется: ни в счетах, ни в документах, ни в отчётах — это поле-ссылка.
 *
 * Сделано по образцу предупреждения об аттестации инженера: показываем плашку,
 * но человеку не мешаем.
 */
async function contractWarningFor(
  db: Db,
  tenantId: string,
  clientId: string,
  contractId: string | null | undefined,
): Promise<string | null> {
  if (contractId) return null;
  const subtype = await clientSubtype(db, tenantId, clientId);
  if (subtype !== 'budget') return null;
  return 'У бюджетной организации не указан контракт — проверьте, нужен ли он для этой работы';
}

/**
 * Stage 10'.I — compliance-проверка инженер↔категория ассета. Возвращает текст
 * предупреждения или null. Не блокирует — диспетчер увидит плашку в UI.
 */
async function attestationWarningFor(
  db: Db,
  tenantId: string,
  assetId: string | null | undefined,
  engineerId: string | null | undefined,
): Promise<string | null> {
  if (!assetId || !engineerId) return null;
  const required = await getAssetRequiredAttestation(db, tenantId, assetId);
  if (!required) return null;
  return checkAttestationForAssignment(db, tenantId, {
    engineerId,
    requiredCategory: required,
  });
}

export interface CreateTicketResult {
  id: string;
  ticketNumber: string;
  barcode: string;
  /** Stage 10'.I — ненулевое сообщение если инженер назначен без действующей аттестации. */
  attestationWarning: string | null;
  /**
   * Мягкая подсказка: у бюджетной организации не указан контракт. Работу НЕ блокирует.
   * Веб плашкой её при СОЗДАНИИ не показывает — там подсказка стоит прямо в форме,
   * рядом с полем «Договор», и человек видит её ДО отправки. Поле возвращаем для
   * симметрии с update и для мобильного клиента.
   */
  contractWarning: string | null;
}

export async function createTicketCmd(
  ctx: CmdCtx,
  input: CreateTicketInput,
): Promise<CreateTicketResult> {
  await ensureRefsExist(ctx.db, ctx.tenant.id, {
    clientId: input.clientId,
    assetId: input.assetId ?? null,
    dispatcherId: input.assignedDispatcherId ?? null,
    engineerId: input.assignedEngineerId ?? null,
    contractId: input.contractId ?? null,
  });
  const contractWarning = await contractWarningFor(
    ctx.db,
    ctx.tenant.id,
    input.clientId,
    input.contractId ?? null,
  );
  const attestationWarning = await attestationWarningFor(
    ctx.db,
    ctx.tenant.id,
    input.assetId ?? null,
    input.assignedEngineerId ?? null,
  );
  const result = await repoCreateTicket(ctx.db, ctx.tenant.id, ctx.session.userId, input);
  if (input.assignedEngineerId) {
    enqueuePushToUser({
      tenantId: ctx.tenant.id,
      userId: input.assignedEngineerId,
      payload: {
        title: `Новая заявка ${result.ticketNumber}`,
        body: 'Вам назначена новая заявка. Откройте, чтобы посмотреть детали.',
        url: `/m/queue?ticketId=${result.id}`,
        tag: `ticket-assign-${result.id}`,
        data: { ticketId: result.id, ticketNumber: result.ticketNumber },
      },
    }).catch((err: unknown) => {
      logger.warn({ err, ticketId: result.id }, 'enqueue push on create failed');
    });
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'ticket',
    entityId: result.id,
    after: {
      ticketNumber: result.ticketNumber,
      clientId: input.clientId,
      assetId: input.assetId ?? null,
      priority: input.priority ?? 'normal',
      repairType: input.repairType ?? 'paid',
    },
    context: attestationWarning ? { attestation_warning: attestationWarning } : null,
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { ...result, attestationWarning, contractWarning };
}

export interface UpdateTicketResult {
  /** Stage 10'.I — предупреждение, если инженер назначен/переназначен без аттестации. */
  attestationWarning: string | null;
  /** Мягкая подсказка: у бюджетной организации не указан контракт. Работу НЕ блокирует. */
  contractWarning: string | null;
}

export async function updateTicketCmd(
  ctx: CmdCtx,
  id: string,
  patch: UpdateTicketInput,
): Promise<UpdateTicketResult> {
  const before = await repoGetTicket(ctx.db, ctx.tenant.id, id);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });

  await ensureRefsExist(ctx.db, ctx.tenant.id, {
    clientId: patch.clientId,
    assetId: patch.assetId ?? null,
    dispatcherId: patch.assignedDispatcherId ?? null,
    engineerId: patch.assignedEngineerId ?? null,
    contractId: patch.contractId ?? null,
  });
  // Меняем клиента или контракт — считаем подсказку заново по итоговым значениям.
  // Не блокируем: у госучреждения контракта может не быть, и это нормально.
  let contractWarning: string | null = null;
  if (patch.clientId !== undefined || patch.contractId !== undefined) {
    const effectiveClientId = patch.clientId ?? before.clientId;
    const effectiveContractId =
      patch.contractId !== undefined ? patch.contractId : before.contractId;
    contractWarning = await contractWarningFor(
      ctx.db,
      ctx.tenant.id,
      effectiveClientId,
      effectiveContractId,
    );
  }

  // Stage 10'.I — compliance-проверка для итогового назначения (engineer + asset).
  // Берём патч-значения там где они заданы, иначе значения из before.
  const effectiveAssetId = patch.assetId !== undefined ? patch.assetId : before.assetId;
  const effectiveEngineerId =
    patch.assignedEngineerId !== undefined ? patch.assignedEngineerId : before.assignedEngineerId;
  const attestationWarning = await attestationWarningFor(
    ctx.db,
    ctx.tenant.id,
    effectiveAssetId,
    effectiveEngineerId,
  );

  const { events } = await repoUpdateTicket(ctx.db, ctx.tenant.id, ctx.session.userId, id, patch);

  // Push инженеру при назначении/переназначении на него заявки.
  for (const e of events) {
    if (e.type !== 'assignment_change' || e.payload.role !== 'engineer') continue;
    const engineerId = typeof e.payload.to === 'string' ? e.payload.to : null;
    if (!engineerId) continue;
    enqueuePushToUser({
      tenantId: ctx.tenant.id,
      userId: engineerId,
      payload: {
        title: `Новая заявка ${before.ticketNumber}`,
        body: 'Вам назначена заявка. Откройте, чтобы посмотреть детали.',
        url: `/m/queue?ticketId=${id}`,
        tag: `ticket-assign-${id}`,
        data: { ticketId: id, ticketNumber: before.ticketNumber },
      },
    }).catch((err: unknown) => {
      logger.warn({ err, ticketId: id, engineerId }, 'enqueue push failed');
    });
  }

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket',
    entityId: id,
    after: {
      ticketNumber: before.ticketNumber,
      patchKeys: Object.keys(patch),
      eventsRecorded: events.map((e) => e.type),
    },
    context: attestationWarning ? { attestation_warning: attestationWarning } : null,
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { attestationWarning, contractWarning };
}

const REOPEN_STATUSES: ReadonlySet<TicketStatus> = new Set([
  'received',
  'diagnostics',
  'estimate',
  'approval',
  'in_progress',
  'act_pending',
]);

/**
 * Разрешённые переходы между статусами заявки.
 *   received    → diagnostics | cancelled
 *   diagnostics → in_progress | cancelled
 *   in_progress → act_pending | cancelled
 *   act_pending → closed | in_progress                (отозвать на доделку)
 *   closed      → ∅                                   (только директор через reopen)
 *   cancelled   → ∅                                   (только директор через reopen)
 *
 * Стадии «Смета» (estimate) и «Согласование» (approval) убраны из потока. Значения
 * enum сохранены (устаревшие) ради истории и типобезопасности; если легаси-заявка
 * вдруг окажется в них — разрешаем только выход в работу/отмену, чтобы не застряла.
 *
 * Идемпотентность: from === to — это no-op, не ошибка.
 */
const ALLOWED_TRANSITIONS: Record<TicketStatus, ReadonlyArray<TicketStatus>> = {
  received: ['diagnostics', 'cancelled'],
  diagnostics: ['in_progress', 'cancelled'],
  estimate: ['in_progress', 'cancelled'], // устаревший статус (вне потока)
  approval: ['in_progress', 'cancelled'], // устаревший статус (вне потока)
  in_progress: ['act_pending', 'cancelled'],
  act_pending: ['closed', 'in_progress'],
  closed: [],
  cancelled: [],
};

export class InvalidStatusTransitionError extends Error {
  constructor(
    public readonly from: TicketStatus,
    public readonly to: TicketStatus,
  ) {
    super(`Нельзя перевести заявку из ${from} в ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

function assertTransitionAllowed(from: TicketStatus, to: TicketStatus): void {
  if (from === to) return; // идемпотентность
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}

export async function changeStatusCmd(
  ctx: CmdCtx,
  id: string,
  newStatus: TicketStatus,
  cancelReason?: string | null,
): Promise<{ id: string; from: TicketStatus; to: TicketStatus }> {
  const before = await repoGetTicket(ctx.db, ctx.tenant.id, id);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
  // Инженер меняет статус только своих заявок: `engineerProcedure` — это
  // проверка роли, а не принадлежности.
  assertEngineerMayEdit(ctx.session, {
    assignedEngineerId: before.assignedEngineerId,
    helperEngineerIds: before.helperEngineers.map((e) => e.userId),
  });

  // reopen из закрытого/отменённого — только director (RBAC проверяется в роутере),
  // здесь валидируем согласованность переходов
  const isReopen =
    (before.status === 'closed' || before.status === 'cancelled') && REOPEN_STATUSES.has(newStatus);
  if (isReopen && ctx.session.role !== 'director') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Reopen заявки доступен только директору',
    });
  }

  // Reopen режим обходит таблицу переходов (терминальные статусы → активный),
  // RBAC выше уже разрешил это только директору. Все прочие переходы валидируем.
  if (!isReopen) {
    try {
      assertTransitionAllowed(before.status, newStatus);
    } catch (err) {
      if (err instanceof InvalidStatusTransitionError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      throw err;
    }
  }

  const result = await repoChangeStatus(
    ctx.db,
    ctx.tenant.id,
    ctx.session.userId,
    id,
    newStatus,
    cancelReason ?? null,
  );

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket',
    entityId: id,
    after: {
      ticketNumber: before.ticketNumber,
      status: newStatus,
      from: result.from,
      hadReason: Boolean(cancelReason),
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });

  // ⛔ ПИСЬМО КЛИЕНТУ О СМЕНЕ СТАТУСА ОТКЛЮЧЕНО (решение владельца 2026-07-23:
  // «почта автоматически ничего не должна отправлять сама»). Раньше здесь ставилась
  // задача `enqueueTicketStatusNotify`, и робот писал клиенту на семи статусах.
  // Письмо теперь отправляет только человек — руками из раздела «Почта».
  // Чтобы вернуть: снова вызвать enqueueTicketStatusNotify здесь И зарегистрировать
  // воркер в index.ts (сам воркер и шаблоны письма никуда не делись).
  //
  // Push-уведомление НИЖЕ — это НЕ почта: оно приходит своему же менеджеру
  // в браузер, наружу ничего не уходит. Поэтому оставлено.
  if (result.from !== result.to) {
    // Заявка готова к выдаче → push менеджеру «позвонить клиенту» (доставится, когда
    // на проде включён VAPID web-push). Шлём назначенному диспетчеру, если он задан.
    if (result.to === 'act_pending' && before.assignedDispatcherId) {
      enqueuePushToUser({
        tenantId: ctx.tenant.id,
        userId: before.assignedDispatcherId,
        payload: {
          title: `Готова к выдаче: ${before.ticketNumber}`,
          body: 'Заявка готова — позвоните клиенту и согласуйте выдачу.',
          url: `/tickets/${id}`,
          tag: `ticket-ready-${id}`,
          data: { ticketId: id, ticketNumber: before.ticketNumber, kind: 'ready_for_pickup' },
        },
      }).catch((err: unknown) => {
        logger.warn({ err, ticketId: id }, 'enqueue ready push failed');
      });
    }
  }
  return result;
}

export async function cancelTicketCmd(
  ctx: CmdCtx,
  id: string,
  reason?: string | null,
): Promise<{ id: string; from: TicketStatus; to: TicketStatus }> {
  return changeStatusCmd(ctx, id, 'cancelled', reason ?? null);
}

export async function reopenTicketCmd(
  ctx: CmdCtx,
  id: string,
): Promise<{ id: string; from: TicketStatus; to: TicketStatus }> {
  return changeStatusCmd(ctx, id, 'received', null);
}

/**
 * Удаление заявки (мягкое). Директор-only (RBAC в роутере). Заявка исчезает из всех
 * списков/отчётов, данные физически остаются (обратимо). Заявки с оплатами или
 * выставленными счетами удалить нельзя — репозиторий вернёт status='blocked'.
 * Чувствительный текст (причина) в audit не пишем — только факт удаления.
 */
export async function deleteTicketCmd(
  ctx: CmdCtx,
  id: string,
  reason?: string | null,
): Promise<{ id: string }> {
  const res = await repoSoftDeleteTicket(ctx.db, ctx.tenant.id, id);
  if (res.status === 'not_found') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
  }
  if (res.status === 'blocked') {
    const parts: string[] = [];
    if (res.blockers.payments > 0) parts.push(`оплаты (${res.blockers.payments})`);
    if (res.blockers.issuedInvoices > 0) {
      parts.push(`выставленные счета (${res.blockers.issuedInvoices})`);
    }
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        `Нельзя удалить заявку: у неё есть ${parts.join(' и ')}. ` +
        'Сначала отмените заявку или разберитесь с деньгами — иначе пострадают касса и отчёты.',
    });
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'ticket',
    entityId: id,
    after: { ticketNumber: res.ticketNumber, hadReason: Boolean(reason) },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { id };
}

export async function addTicketNoteCmd(
  ctx: CmdCtx,
  ticketId: string,
  comment: string,
): Promise<{ id: string }> {
  // Комментарий инженер пишет только в свою заявку.
  await assertEngineerMayEditTicketId(ctx.db, ctx.tenant.id, ctx.session, ticketId);
  const result = await repoAddNote(ctx.db, ctx.tenant.id, ctx.session.userId, ticketId, comment);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'ticket_event',
    entityId: result.id,
    after: { type: 'note', ticketId },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

/**
 * Фича A — установить/снять флаг «Ждём запчасть». RBAC (staff) — в роутере.
 * Пишет note-событие в журнал (через repo) + audit.
 */
export async function setWaitingForPartCmd(
  ctx: CmdCtx,
  ticketId: string,
  waiting: boolean,
  note: string | null,
): Promise<{ id: string; waitingForPart: boolean; waitingForPartNote: string | null }> {
  let result;
  try {
    result = await repoSetWaitingForPart(
      ctx.db,
      ctx.tenant.id,
      ctx.session.userId,
      ticketId,
      waiting,
      note,
    );
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket',
    entityId: ticketId,
    after: { waitingForPart: result.waitingForPart, hasNote: Boolean(result.waitingForPartNote) },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

/**
 * Установить/снять структурную причину простоя (доска «почему стоит»). RBAC (staff) — в роутере.
 * reason=null снимает простой. Синхронизацию с флагом «ждём запчасть» и запись события
 * делает repo. Плюс audit.
 */
export async function setBlockedReasonCmd(
  ctx: CmdCtx,
  ticketId: string,
  reason: TicketBlockedReason | null,
  note: string | null,
): Promise<{
  id: string;
  blockedReason: TicketBlockedReason | null;
  blockedSince: Date | null;
  waitingForPart: boolean;
  waitingForPartNote: string | null;
}> {
  let result;
  try {
    result = await repoSetBlockedReason(
      ctx.db,
      ctx.tenant.id,
      ctx.session.userId,
      ticketId,
      reason,
      note,
    );
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket',
    entityId: ticketId,
    after: { blockedReason: result.blockedReason, blocked: result.blockedReason != null },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

/* ─────────── Фича №3 «Трек как посылку» — публичная ссылка (staff) ─────────── */

/**
 * Выдать (создав при первом обращении) публичную ссылку отслеживания заявки.
 * RBAC (staff) — в роутере. Идемпотентно: повторный вызов отдаёт тот же токен.
 */
export async function getTrackShareCmd(ctx: CmdCtx, ticketId: string): Promise<{ token: string }> {
  let token: string;
  try {
    token = await repoGetOrCreateTrackToken(ctx.db, ctx.tenant.id, ticketId);
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket',
    entityId: ticketId,
    after: { trackShare: 'enabled' },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { token };
}

/** Отозвать публичную ссылку отслеживания (старая ссылка перестаёт работать). */
export async function revokeTrackShareCmd(ctx: CmdCtx, ticketId: string): Promise<{ ok: true }> {
  try {
    await repoRevokeTrackToken(ctx.db, ctx.tenant.id, ticketId);
  } catch (err) {
    throw toTRPCError(err);
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket',
    entityId: ticketId,
    after: { trackShare: 'revoked' },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { ok: true };
}

/** Доска «кто чем занят / почему стоит» — все активные заявки одним запросом (staff). */
export async function boardQuery(db: Db, tenant: ResolvedTenant): Promise<BoardTicketDto[]> {
  return repoBoardTickets(db, tenant.id);
}

/** Фича №7 — заявки, стоящие из-за ожидания детали (staff). Дольше всех — сверху. */
export async function partsWaitingQuery(
  db: Db,
  tenant: ResolvedTenant,
): Promise<PartWaitingItem[]> {
  return repoPartsWaitingList(db, tenant.id);
}

/**
 * «Мой день» — активные заявки инженера с полями доски (stuckDays/light/причина).
 * Активных заявок у tenant'а немного (сотни максимум) — фильтруем в памяти,
 * чтобы не плодить второй SQL-вариант boardTickets.
 */
export async function myTicketsQuery(
  db: Db,
  tenant: ResolvedTenant,
  engineerId: string,
): Promise<BoardTicketDto[]> {
  const all = await repoBoardTickets(db, tenant.id);
  // «Мой день» показывает и заявки, где инженер ПОМОЩНИК: он на них так же выезжает.
  const helperIds = new Set(await repoListHelperTicketIds(db, tenant.id, engineerId));
  return all.filter((t) => t.assignedEngineerId === engineerId || helperIds.has(t.id));
}

export interface SetTicketEngineersResult {
  /** Кто теперь помощники — уже без ответственного, если его прислали по ошибке. */
  helperEngineers: Array<{ userId: string; fullName: string | null }>;
}

/**
 * Заменяет список ПОМОЩНИКОВ по заявке целиком.
 *
 * Ответственный назначается по-старому (полем assignedEngineerId) и в этот список
 * не входит — см. setTicketEngineers в репозитории: если его прислали, он молча
 * выбрасывается, чтобы человек не оказался в заявке дважды.
 *
 * Аттестацию помощников НЕ проверяем намеренно: она обязательна тому, кто отвечает
 * за работу, а помощник может быть учеником или второй парой рук. Предупреждение
 * по ответственному продолжает работать как раньше.
 */
export async function setTicketEngineersCmd(
  ctx: CmdCtx,
  ticketId: string,
  userIds: string[],
): Promise<SetTicketEngineersResult> {
  const before = await repoGetTicket(ctx.db, ctx.tenant.id, ticketId);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });

  // Каждый помощник должен быть живым пользователем этого тенанта: иначе в заявку
  // можно было бы вписать чужой id и «подсветить» ему чужие данные.
  for (const userId of userIds) {
    const ok = await userBelongsToTenant(ctx.db, ctx.tenant.id, userId);
    if (!ok) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Инженер не найден в tenant' });
  }

  try {
    await repoSetTicketEngineers(ctx.db, ctx.tenant.id, ticketId, userIds);
  } catch (err) {
    throw toTRPCError(err);
  }
  const helperEngineers = await repoListTicketEngineers(ctx.db, ctx.tenant.id, ticketId);

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'ticket',
    entityId: ticketId,
    before: { helperEngineerIds: before.helperEngineers.map((e) => e.userId) },
    after: { helperEngineerIds: helperEngineers.map((e) => e.userId) },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });

  return { helperEngineers };
}

/** Реакция инженера одной кнопкой (Telegram / web-push / «Мой день»). */
export type EngineerReactAction = 'inwork' | 'ready' | 'part' | 'start';

export interface EngineerReactResult {
  kind: EngineerReactAction | 'noop';
  /** Человеческое подтверждение — показывается в тосте/боте. */
  message: string;
  ticketNumber: string;
}

/**
 * Единая команда «инженер ответил одной кнопкой»:
 *   start  — «взял в работу»: из «Принята» доводит до in_progress через
 *            диагностику (машина статусов идёт по шагам, перепрыгнуть нельзя);
 *   inwork — заметка «ещё в работе», бот замолкает по заявке на 2 дня;
 *   ready  — перевод в act_pending (готова к выдаче) со всеми штатными эффектами
 *            (письмо клиенту, push диспетчеру «позвоните клиенту»);
 *   part   — причина простоя «ждём запчасть» на доске.
 *
 * RBAC: инженер может реагировать ТОЛЬКО на свою заявку — где он ответственный
 * ИЛИ помощник; director/dispatcher — на любую. Вызывается из tRPC-роутера и из
 * Telegram-вебхука (там ctx собирается синтетически из привязанного пользователя).
 */
export async function engineerReactCmd(
  ctx: CmdCtx,
  ticketId: string,
  action: EngineerReactAction,
): Promise<EngineerReactResult> {
  const before = await repoGetTicket(ctx.db, ctx.tenant.id, ticketId);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
  // Была своя копия этой проверки — теперь общее определение «своей заявки».
  assertEngineerMayEdit(ctx.session, {
    assignedEngineerId: before.assignedEngineerId,
    helperEngineerIds: before.helperEngineers.map((e) => e.userId),
  });
  if (before.status === 'closed' || before.status === 'cancelled') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Заявка уже закрыта' });
  }

  /**
   * «Взял в работу». Инженер жмёт это в списке, не открывая заявку.
   *
   * Повторный тап — не ошибка: палец соскользнул, связь моргнула, очередь
   * прислала запись второй раз. Отвечаем noop, статус не двигаем — иначе
   * второе нажатие увело бы заявку в «готова к выдаче».
   */
  if (action === 'start') {
    if (before.status === 'in_progress' || before.status === 'act_pending') {
      await clearUnansweredCount(ctx.tenant.id, ticketId);
      return {
        kind: 'noop',
        ticketNumber: before.ticketNumber,
        message: `${before.ticketNumber} уже в работе.`,
      };
    }
    // Машина статусов ходит по шагам: received → diagnostics → in_progress.
    // Тем же способом устроен `ready` ниже — перепрыгнуть шаг нельзя.
    if (before.status === 'received') {
      await changeStatusCmd(ctx, ticketId, 'diagnostics');
    }
    await changeStatusCmd(ctx, ticketId, 'in_progress');
    await clearUnansweredCount(ctx.tenant.id, ticketId);
    return {
      kind: 'start',
      ticketNumber: before.ticketNumber,
      message: `${before.ticketNumber} — взяли в работу.`,
    };
  }

  if (action === 'inwork') {
    await addTicketNoteCmd(ctx, ticketId, 'Ответ на напоминание: ещё в работе');
    await snoozeAsk(ctx.tenant.id, ticketId);
    await clearUnansweredCount(ctx.tenant.id, ticketId);
    return {
      kind: 'inwork',
      ticketNumber: before.ticketNumber,
      message: `Принято: ${before.ticketNumber} ещё в работе. Отметил в журнале, пару дней не беспокою.`,
    };
  }

  if (action === 'ready') {
    if (before.status === 'act_pending') {
      await clearUnansweredCount(ctx.tenant.id, ticketId);
      return {
        kind: 'noop',
        ticketNumber: before.ticketNumber,
        message: `${before.ticketNumber} уже отмечена готовой к выдаче.`,
      };
    }
    // Из «Диагностики» идём через in_progress — та же пара нажатий, что инженер
    // сделал бы в карточке. Из received «готово» не пускаем (ещё не в работе).
    if (before.status === 'received') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `${before.ticketNumber} ещё не в работе — откройте заявку и начните диагностику.`,
      });
    }
    // diagnostics — основной путь; estimate/approval — устаревшие статусы (легаси-заявки).
    if (
      before.status === 'diagnostics' ||
      before.status === 'estimate' ||
      before.status === 'approval'
    ) {
      await changeStatusCmd(ctx, ticketId, 'in_progress');
    }
    await changeStatusCmd(ctx, ticketId, 'act_pending');
    await clearUnansweredCount(ctx.tenant.id, ticketId);
    return {
      kind: 'ready',
      ticketNumber: before.ticketNumber,
      message: `Готово: ${before.ticketNumber} → «Ожидает акта». Диспетчер получил сигнал позвонить клиенту.`,
    };
  }

  // action === 'part'
  if (before.blockedReason === 'waiting_part') {
    await clearUnansweredCount(ctx.tenant.id, ticketId);
    return {
      kind: 'noop',
      ticketNumber: before.ticketNumber,
      message: `По ${before.ticketNumber} уже стоит «ждём запчасть».`,
    };
  }
  await setBlockedReasonCmd(
    ctx,
    ticketId,
    'waiting_part',
    'Отметил инженер (ответ на напоминание)',
  );
  await snoozeAsk(ctx.tenant.id, ticketId);
  await clearUnansweredCount(ctx.tenant.id, ticketId);
  return {
    kind: 'part',
    ticketNumber: before.ticketNumber,
    message: `Принято: по ${before.ticketNumber} ждём запчасть. Менеджер видит это на доске.`,
  };
}

export async function recordPrintEventCmd(
  ctx: CmdCtx,
  ticketId: string,
  documentKind: 'intake_act' | 'invoice' | 'work_act' | 'defect_act' | 'tech_condition_act',
): Promise<{ id: string }> {
  // Инженер фиксирует печать только по своим заявкам (см. assertEngineerOwnsTicket).
  // «Свои» — где он ответственный ИЛИ помощник.
  const ticket = await repoGetTicket(ctx.db, ctx.tenant.id, ticketId);
  if (!ticket) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
  assertEngineerOwnsTicket(ctx.session, {
    assignedEngineerId: ticket.assignedEngineerId,
    helperEngineerIds: ticket.helperEngineers.map((e) => e.userId),
  });

  const result = await repoRecordPrint(
    ctx.db,
    ctx.tenant.id,
    ctx.session.userId,
    ticketId,
    documentKind,
  );
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'ticket_event',
    entityId: result.id,
    after: { type: 'document_printed', documentKind, ticketId },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

export async function getTicketQuery(db: Db, tenant: ResolvedTenant, id: string) {
  const t = await repoGetTicket(db, tenant.id, id);
  if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
  return t;
}

/** Роль+пользователь, достаточные для проверки «своя ли заявка». */
type ActorSession = { role: 'director' | 'dispatcher' | 'engineer'; userId: string };

/** Заявка глазами проверки доступа: кто отвечает и кто помогает. */
export interface TicketOwnership {
  assignedEngineerId: string | null;
  helperEngineerIds?: string[];
}

/**
 * «Своя» заявка инженера = он ответственный ИЛИ помощник.
 *
 * Помощник выполнял ремонт наравне с ответственным (см. ticket_engineers,
 * мигр. 0080) — без этой ветки он видел бы заявку у себя в списке и упирался
 * в «не ваша заявка». Директор и диспетчер не ограничены.
 *
 * Чистая функция: одно определение «своей заявки» и на документы, и на правки.
 */
export function engineerMayEditTicket(session: ActorSession, ticket: TicketOwnership): boolean {
  if (session.role !== 'engineer') return true;
  if (ticket.assignedEngineerId === session.userId) return true;
  return (ticket.helperEngineerIds ?? []).includes(session.userId);
}

/**
 * Инженер работает с документами только СВОИХ заявок (директор/диспетчер — любых).
 * Акт печатает тот, кто выполнял ремонт.
 */
export function assertEngineerOwnsTicket(session: ActorSession, ticket: TicketOwnership): void {
  if (engineerMayEditTicket(session, ticket)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Документы по заявке доступны только назначенному инженеру',
  });
}

/**
 * Инженер МЕНЯЕТ только свои заявки. Смотреть можно любые — приехал на
 * объект, отсканировал аппарат, надо понять, что это. Менять — нет:
 * `engineerProcedure` проверяет РОЛЬ, а не принадлежность, и без этой
 * проверки инженер мог сменить статус чужой заявки, написать в неё
 * комментарий и добавить строку в чужой наряд с любой ценой и любым
 * исполнителем — а от строк наряда считается зарплата.
 *
 * Решение владельца 2026-08-07: «смотреть всем, менять — только свои».
 */
export function assertEngineerMayEdit(session: ActorSession, ticket: TicketOwnership): void {
  if (engineerMayEditTicket(session, ticket)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Это не ваша заявка — смотреть можно, менять нельзя. Обратитесь к диспетчеру.',
  });
}

/**
 * То же, но заявку сначала надо прочитать из базы: у команд на входе только
 * её идентификатор.
 */
export async function assertEngineerMayEditTicketId(
  db: Db,
  tenantId: string,
  session: ActorSession,
  ticketId: string,
): Promise<void> {
  if (session.role !== 'engineer') return;
  const t = await repoGetTicket(db, tenantId, ticketId);
  if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
  assertEngineerMayEdit(session, {
    assignedEngineerId: t.assignedEngineerId,
    helperEngineerIds: t.helperEngineers.map((e) => e.userId),
  });
}

/**
 * Полная проверка права ПРАВИТЬ НАРЯД: своя ли заявка И не закрыта ли она
 * слишком давно. Обе проверки здесь, потому что обе требуют одну и ту же
 * заявку — читаем её один раз.
 */
export async function assertMayEditWorkOrderOfTicket(
  db: Db,
  tenantId: string,
  session: ActorSession,
  ticketId: string,
  now: number = Date.now(),
): Promise<void> {
  const t = await repoGetTicket(db, tenantId, ticketId);
  if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
  assertEngineerMayEdit(session, {
    assignedEngineerId: t.assignedEngineerId,
    helperEngineerIds: t.helperEngineers.map((e) => e.userId),
  });
  assertWorkOrderEditable(session.role, { status: t.status, closedAt: t.closedAt }, now);
}

/**
 * Реквизиты клиента, необходимые для печати документов по заявке (акт работ,
 * дефектный акт). Отдаём МИНИМУМ полей — без email, прочих контактов и всей
 * карточки клиента, — чтобы инженер мог сам сформировать полноценный акт,
 * не получая доступ к карточке клиента (`clients.get` остаётся staff-only).
 */
export async function documentClientQuery(
  db: Db,
  tenant: ResolvedTenant,
  session: ActorSession,
  ticketId: string,
) {
  const t = await repoGetTicket(db, tenant.id, ticketId);
  if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
  assertEngineerOwnsTicket(session, {
    assignedEngineerId: t.assignedEngineerId,
    helperEngineerIds: t.helperEngineers.map((e) => e.userId),
  });

  const client = await getClientQuery(db, tenant, t.clientId);
  const contact =
    (t.contactId ? client.contacts.find((c) => c.id === t.contactId) : undefined) ??
    client.contacts.find((c) => c.isPrimary) ??
    client.contacts[0];

  return {
    displayName: client.displayName,
    inn: client.inn,
    kpp: client.kpp,
    ogrn: client.ogrn,
    legalAddress: client.legalAddress,
    phone: client.phone,
    contactName: contact?.fullName ?? null,
    contactPosition: contact?.position ?? null,
  };
}

export async function listTicketsQuery(db: Db, tenant: ResolvedTenant, opts: ListTicketsOpts) {
  return repoListTickets(db, tenant.id, opts);
}

export async function listEventsQuery(
  db: Db,
  tenant: ResolvedTenant,
  ticketId: string,
  limit?: number,
) {
  // ticket_events не джойнит tickets → отдельно проверяем, что заявка жива (не удалена).
  const ticket = await repoGetTicket(db, tenant.id, ticketId);
  if (!ticket) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена' });
  return repoListEvents(db, tenant.id, ticketId, limit);
}

export async function searchTicketsQuery(db: Db, tenant: ResolvedTenant, q: string) {
  return repoSearchTickets(db, tenant.id, q);
}

/* ──────────────────────── Stage 11: Schedule ──────────────────────── */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScheduleCmdInput {
  ticketId: string;
  engineerId: string;
  scheduledStartAt: Date;
  scheduledEndAt?: Date | null;
  estimatedMinutes?: number | null;
}

export interface ScheduleCmdResult {
  ticketId: string;
  ticketNumber: string;
  scheduledStartAt: Date;
  scheduledEndAt: Date | null;
  estimatedMinutes: number | null;
  engineerId: string;
}

/**
 * Stage 11 — поставить заявку на график. Атомарно (UPDATE + audit в одной tx).
 * После tx — fire-and-forget push инженеру.
 */
export async function scheduleCmd(
  ctx: CmdCtx,
  input: ScheduleCmdInput,
): Promise<ScheduleCmdResult> {
  // Проверяем что инженер есть в tenant'е (роль engineer обязательна).
  const engineerOk = await userBelongsToTenant(ctx.db, ctx.tenant.id, input.engineerId, 'engineer');
  if (!engineerOk) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Инженер не найден в tenant' });
  }

  let result: ScheduleCmdResult;
  try {
    result = await withTenantTx(ctx.db, ctx.tenant.id, async (tx) => {
      const r = await repoSchedule(tx, {
        ticketId: input.ticketId,
        engineerId: input.engineerId,
        scheduledStartAt: input.scheduledStartAt,
        scheduledEndAt: input.scheduledEndAt ?? null,
        estimatedMinutes: input.estimatedMinutes ?? null,
      });
      await writeAuditInTx(tx, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'schedule_change',
        entityType: 'ticket',
        entityId: r.ticketId,
        before: {
          engineerId: r.before.engineerId,
          scheduledStartAt: r.before.scheduledStartAt,
          scheduledEndAt: r.before.scheduledEndAt,
          estimatedMinutes: r.before.estimatedMinutes,
        },
        after: {
          engineerId: r.after.engineerId,
          scheduledStartAt: r.after.scheduledStartAt,
          scheduledEndAt: r.after.scheduledEndAt,
          estimatedMinutes: r.after.estimatedMinutes,
        },
        ip: ctx.audit.ip ?? null,
        userAgent: ctx.audit.userAgent ?? null,
      });
      return {
        ticketId: r.ticketId,
        ticketNumber: r.ticketNumber,
        scheduledStartAt: input.scheduledStartAt,
        scheduledEndAt: input.scheduledEndAt ?? null,
        estimatedMinutes: input.estimatedMinutes ?? null,
        engineerId: input.engineerId,
      };
    });
  } catch (err) {
    throw toTRPCError(err);
  }

  // Fire-and-forget push инженеру. Дедуп по ticketId+kind в tag.
  enqueuePushToUser({
    tenantId: ctx.tenant.id,
    userId: input.engineerId,
    payload: {
      title: `График: заявка ${result.ticketNumber}`,
      body: 'Вам поставлена заявка в график. Откройте, чтобы посмотреть детали.',
      url: `/m/queue?ticketId=${result.ticketId}`,
      tag: `ticket-schedule-${result.ticketId}`,
      data: {
        ticketId: result.ticketId,
        ticketNumber: result.ticketNumber,
        kind: 'schedule_change',
      },
    },
  }).catch((err: unknown) => {
    logger.warn({ err, ticketId: result.ticketId }, 'enqueue schedule push failed');
  });

  return result;
}

export interface UnscheduleCmdInput {
  ticketId: string;
}

export interface UnscheduleCmdResult {
  ticketId: string;
  ticketNumber: string;
}

/**
 * Stage 11 — снять заявку с расписания. assigned_engineer_id остаётся —
 * это разные операции в UI диспетчера.
 */
export async function unscheduleCmd(
  ctx: CmdCtx,
  input: UnscheduleCmdInput,
): Promise<UnscheduleCmdResult> {
  let result: UnscheduleCmdResult;
  let priorEngineerId: string | null = null;
  try {
    const r = await withTenantTx(ctx.db, ctx.tenant.id, async (tx) => {
      const repoResult = await repoUnschedule(tx, { ticketId: input.ticketId });
      await writeAuditInTx(tx, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'schedule_change',
        entityType: 'ticket',
        entityId: repoResult.ticketId,
        before: {
          engineerId: repoResult.before.engineerId,
          scheduledStartAt: repoResult.before.scheduledStartAt,
          scheduledEndAt: repoResult.before.scheduledEndAt,
          estimatedMinutes: repoResult.before.estimatedMinutes,
        },
        after: {
          engineerId: repoResult.before.engineerId,
          scheduledStartAt: null,
          scheduledEndAt: null,
          estimatedMinutes: null,
        },
        ip: ctx.audit.ip ?? null,
        userAgent: ctx.audit.userAgent ?? null,
      });
      return repoResult;
    });
    priorEngineerId = r.before.engineerId;
    result = { ticketId: r.ticketId, ticketNumber: r.ticketNumber };
  } catch (err) {
    throw toTRPCError(err);
  }

  if (priorEngineerId) {
    enqueuePushToUser({
      tenantId: ctx.tenant.id,
      userId: priorEngineerId,
      payload: {
        title: `График: заявка ${result.ticketNumber}`,
        body: 'Заявка снята с расписания.',
        url: `/m/queue?ticketId=${result.ticketId}`,
        tag: `ticket-unschedule-${result.ticketId}`,
        data: {
          ticketId: result.ticketId,
          ticketNumber: result.ticketNumber,
          kind: 'schedule_change',
        },
      },
    }).catch((err: unknown) => {
      logger.warn({ err, ticketId: result.ticketId }, 'enqueue unschedule push failed');
    });
  }

  return result;
}

export interface WeeklyScheduleQueryInput {
  weekStart: Date;
}

/**
 * Stage 11 — staff-view расписания. weekEnd считается на сервисе (weekStart + 7 дней).
 */
export async function weeklyScheduleQuery(
  ctx: CmdCtx,
  input: WeeklyScheduleQueryInput,
): Promise<ScheduledTicketDto[]> {
  const weekEnd = new Date(input.weekStart.getTime() + WEEK_MS);
  return withTenantTx(ctx.db, ctx.tenant.id, (tx) =>
    repoWeeklySchedule(tx, { weekStart: input.weekStart, weekEnd }),
  );
}

/**
 * Stage 11 — engineer-view: расписание текущего пользователя.
 */
export async function myWeeklyScheduleQuery(
  ctx: CmdCtx,
  input: WeeklyScheduleQueryInput,
): Promise<ScheduledTicketDto[]> {
  const weekEnd = new Date(input.weekStart.getTime() + WEEK_MS);
  return withTenantTx(ctx.db, ctx.tenant.id, (tx) =>
    repoMyWeeklySchedule(tx, {
      engineerId: ctx.session.userId,
      weekStart: input.weekStart,
      weekEnd,
    }),
  );
}
