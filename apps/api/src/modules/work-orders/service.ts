/**
 * Service слой work-orders.
 *
 * Бизнес-инвариант: total_amount_kopecks материализован — пересчитывается в
 * recalcTotals() (см. repository.ts) при каждом upsert/delete строки.
 *
 * В audit logs не пишем «name» / «comment» строки и diagnosis/repairDescription —
 * там может быть PII или жалобы пациента (см. logger redact).
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import type { VatRate } from '@erfolg/shared';
import { writeAudit } from '../../lib/audit';
import {
  deleteLine as repoDeleteLine,
  getOrCreateWorkOrder as repoGetOrCreate,
  getWorkOrderByTicket as repoGetByTicket,
  updateWorkOrderHeader as repoUpdateHeader,
  upsertLine as repoUpsertLine,
  workOrderIdForTicket,
  type UpdateHeaderInput,
  type UpsertLineInput,
  type WorkOrderDto,
  type WorkOrderLineDto,
} from './repository';
import { getTicket } from '../tickets/repository';
import { assertMayEditWorkOrderOfTicket } from '../tickets/service';
import { phraseWithLlm } from '../ai-assistant/proactive';
import {
  COMPOSE_SYSTEM_PROMPT,
  composeFromNotes,
  inventsFacts,
  parseComposedJson,
  type ComposedNotes,
} from './compose-notes';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';

export async function getWorkOrderByTicketQuery(
  db: Db,
  tenant: ResolvedTenant,
  ticketId: string,
): Promise<WorkOrderDto | null> {
  return repoGetByTicket(db, tenant.id, ticketId);
}

/* ─────────── Фича №13 «AI-черновик акта» — текст «Выполненные работы» ─────────── */

export interface DraftRepairDescriptionResult {
  /** Готовый черновик текста «Выполненные работы» (можно править перед сохранением). */
  text: string;
  /** true — текст сгенерирован ИИ; false — простой черновик собран из строк наряда (деградация). */
  aiUsed: boolean;
}

/** Черновик из строк наряда — фолбэк, если ИИ не настроен или недоступен. */
function buildFallbackDescription(
  works: WorkOrderLineDto[],
  parts: WorkOrderLineDto[],
  diagnosis: string | null,
): string {
  const names = (arr: WorkOrderLineDto[]) =>
    arr
      .map((l) => l.name.trim())
      .filter(Boolean)
      .join('; ');
  const segments: string[] = [];
  if (works.length > 0) segments.push(`Выполнены работы: ${names(works)}.`);
  if (parts.length > 0) segments.push(`Установлены/заменены запчасти: ${names(parts)}.`);
  if (segments.length === 0) {
    // Строк нет — не теряем диагноз инженера, если он заполнен (важно в деградации без LLM).
    const diag = diagnosis?.trim();
    return diag
      ? `По результатам диагностики: ${diag}`
      : 'Работы по заявке выполнены в полном объёме.';
  }
  segments.push('Оборудование протестировано, работоспособность восстановлена.');
  return segments.join(' ');
}

/**
 * Собрать черновик текста «Выполненные работы» для акта из строк наряда
 * (работы/запчасти) + диагноза наряда + симптома заявки. В ИИ уходят ТОЛЬКО
 * технические поля — без имени/телефона/адреса клиента (152-ФЗ). Никогда не
 * бросает из-за ИИ: `phraseWithLlm` при отсутствии/сбое LLM вернёт null → фолбэк.
 */
export async function draftRepairDescriptionQuery(
  db: Db,
  tenant: ResolvedTenant,
  ticketId: string,
): Promise<DraftRepairDescriptionResult> {
  const wo = await repoGetByTicket(db, tenant.id, ticketId);
  if (!wo) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Наряд для этой заявки ещё не создан',
    });
  }
  const works = wo.lines.filter((l) => l.lineType === 'work');
  const parts = wo.lines.filter((l) => l.lineType === 'part');
  const fallback = buildFallbackDescription(works, parts, wo.diagnosis);

  // Нечего описывать (ни строк, ни диагноза) — отдаём базовый текст без вызова ИИ.
  if (works.length === 0 && parts.length === 0 && !wo.diagnosis?.trim()) {
    return { text: fallback, aiUsed: false };
  }

  const ticket = await getTicket(db, tenant.id, ticketId);
  const symptom = ticket?.symptom?.trim() || null;

  const system =
    'Ты помощник инженера сервисного центра медтехники. По данным наряда составь официальный текст ' +
    '«Выполненные работы» для акта выполненных работ. Требования: русский язык, деловой стиль, прошедшее ' +
    'время, 2–4 предложения. Опирайся ТОЛЬКО на приведённые данные — ничего не выдумывай (не добавляй цены, ' +
    'сроки, гарантии, модели и детали, которых нет во входных данных). Не упоминай клиента, пациента и ' +
    'персональные данные. Верни только сам текст, без заголовков и списков.';

  const userLines: string[] = [];
  if (symptom) userLines.push(`Симптом (со слов клиента): ${symptom}`);
  if (wo.diagnosis?.trim()) userLines.push(`Диагноз инженера: ${wo.diagnosis.trim()}`);
  if (works.length > 0)
    userLines.push(
      `Выполненные работы (строки наряда): ${works
        .map((w) => w.name.trim())
        .filter(Boolean)
        .join('; ')}`,
    );
  if (parts.length > 0)
    userLines.push(
      `Использованные запчасти: ${parts
        .map((p) => p.name.trim())
        .filter(Boolean)
        .join('; ')}`,
    );

  const ai = await phraseWithLlm(db, tenant, system, userLines.join('\n'));
  return ai ? { text: ai.trim(), aiUsed: true } : { text: fallback, aiUsed: false };
}

/* ────────── «Инженер пишет своими словами» — разложить на два поля ────────── */

export interface ComposeEngineerNotesResult extends ComposedNotes {
  /** true — раскладывала модель; false — честный разбор без модели. */
  aiUsed: boolean;
  /**
   * Модель ОТВЕТИЛА, но её ответ не взяли: мусор вместо JSON или приписанные
   * факты. Отдельно от `aiUsed`, потому что человеку это разные новости:
   * «ИИ не настроен» ведёт в настройки, «ИИ фантазирует» — к владельцу.
   * Одно сообщение на оба случая врало настроившему модель.
   */
  aiRejected: boolean;
}

/**
 * Разложить написанное инженером своими словами на «Диагноз» и «Описание
 * ремонта». НИЧЕГО НЕ ПИШЕТ: это предложение, которое человек ещё увидит и
 * либо применит, либо нет.
 *
 * Порядок такой: настроена модель — раскладывает она, потому что перефразировать
 * по-человечески умеет только она (ради этого владелец всё и просил). Не
 * настроена, сломалась, ответила мусором или что-то присочинила — работает
 * разбор без модели (compose-notes.ts). Пустой результат инженеру не отдаём
 * никогда: он написал текст и ждёт ответа.
 *
 * ПОЧЕМУ ПРОВЕРЯЕМ ЗА МОДЕЛЬЮ (`inventsFacts`): текст уходит в акт, который
 * подписывает клиент. Выдуманная гарантия или срок — обязательство компании,
 * которого инженер не давал.
 */
export async function composeEngineerNotesQuery(
  ctx: CmdCtx,
  ticketId: string,
  notes: string,
): Promise<ComposeEngineerNotesResult> {
  // Оформляем только то, что человеку и так позволено править: своя заявка и
  // не позже окна правки закрытой (решения владельца 2026-08-07).
  await assertMayEditWorkOrderOfTicket(ctx.db, ctx.tenant.id, ctx.session, ticketId);

  const text = notes.trim();
  // Пусто — раскладывать нечего, и модель звать незачем: с пустого входа она
  // сочинит «работы выполнены в полном объёме».
  if (!text) {
    return { diagnosis: null, repairDescription: null, aiUsed: false, aiRejected: false };
  }

  const local = composeFromNotes(text);
  const answer = await phraseWithLlm(ctx.db, ctx.tenant, COMPOSE_SYSTEM_PROMPT, text);
  // Модели нет или она не ответила — это НЕ её вина, докладывать не о чем.
  if (!answer) return { ...local, aiUsed: false, aiRejected: false };

  const parsed = parseComposedJson(answer);
  if (!parsed) return { ...local, aiUsed: false, aiRejected: true };

  const produced = `${parsed.diagnosis ?? ''} ${parsed.repairDescription ?? ''}`;
  if (inventsFacts(text, produced)) return { ...local, aiUsed: false, aiRejected: true };

  return { ...parsed, aiUsed: true, aiRejected: false };
}

export async function ensureWorkOrderCmd(ctx: CmdCtx, ticketId: string): Promise<WorkOrderDto> {
  await assertMayEditWorkOrderOfTicket(ctx.db, ctx.tenant.id, ctx.session, ticketId);
  const result = await repoGetOrCreate(ctx.db, ctx.tenant.id, ticketId);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'work_order',
    entityId: result.id,
    after: { ticketId, orderNumber: result.orderNumber },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return result;
}

export interface UpsertLineCmdInput extends UpsertLineInput {
  ticketId: string;
  lineId?: string | null;
}

async function resolveWorkOrderForTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<string> {
  const id = await workOrderIdForTicket(db, tenantId, ticketId);
  if (!id) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Наряд для этой заявки ещё не создан — сначала вызовите ensure',
    });
  }
  return id;
}

export async function upsertLineCmd(
  ctx: CmdCtx,
  input: UpsertLineCmdInput,
): Promise<{ id: string; workOrderId: string }> {
  // Строка наряда — это деньги: от неё считается зарплата (процент со строки).
  // Инженер пишет строки только в наряд СВОЕЙ заявки.
  await assertMayEditWorkOrderOfTicket(ctx.db, ctx.tenant.id, ctx.session, input.ticketId);
  const workOrderId = await resolveWorkOrderForTicket(ctx.db, ctx.tenant.id, input.ticketId);
  const result = await repoUpsertLine(ctx.db, ctx.tenant.id, workOrderId, input.lineId ?? null, {
    lineType: input.lineType,
    name: input.name,
    unit: input.unit,
    quantity: input.quantity,
    unitPriceKopecks: input.unitPriceKopecks,
    engineerId: input.engineerId,
    comment: input.comment,
    orderIdx: input.orderIdx,
  });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: input.lineId ? 'update' : 'create',
    entityType: 'work_order_line',
    entityId: result.id,
    after: {
      workOrderId,
      lineType: input.lineType,
      quantity: input.quantity,
      unitPriceKopecks: input.unitPriceKopecks.toString(),
      hasComment: Boolean(input.comment),
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { id: result.id, workOrderId };
}

export async function deleteLineCmd(ctx: CmdCtx, ticketId: string, lineId: string): Promise<void> {
  await assertMayEditWorkOrderOfTicket(ctx.db, ctx.tenant.id, ctx.session, ticketId);
  const workOrderId = await resolveWorkOrderForTicket(ctx.db, ctx.tenant.id, ticketId);
  await repoDeleteLine(ctx.db, ctx.tenant.id, workOrderId, lineId);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'work_order_line',
    entityId: lineId,
    after: { workOrderId },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}

export async function updateHeaderCmd(
  ctx: CmdCtx,
  ticketId: string,
  patch: UpdateHeaderInput,
): Promise<void> {
  await assertMayEditWorkOrderOfTicket(ctx.db, ctx.tenant.id, ctx.session, ticketId);
  const workOrderId = await resolveWorkOrderForTicket(ctx.db, ctx.tenant.id, ticketId);
  await repoUpdateHeader(ctx.db, ctx.tenant.id, workOrderId, patch);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'work_order',
    entityId: workOrderId,
    after: {
      patchKeys: Object.keys(patch),
      vatRateChanged: patch.vatRate !== undefined,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}

export async function setVatRateCmd(
  ctx: CmdCtx,
  ticketId: string,
  vatRate: VatRate,
): Promise<void> {
  const workOrderId = await resolveWorkOrderForTicket(ctx.db, ctx.tenant.id, ticketId);
  await repoUpdateHeader(ctx.db, ctx.tenant.id, workOrderId, { vatRate });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'work_order',
    entityId: workOrderId,
    after: { vatRate },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
}
