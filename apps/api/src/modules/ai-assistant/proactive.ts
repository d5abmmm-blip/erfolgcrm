/**
 * Проактивный AI: утренняя сводка и объяснение «почему заявка застряла».
 *
 * Принцип устойчивости: данные считаются ДЕТЕРМИНИРОВАННО (из доски / истории заявки)
 * и возвращаются всегда. LLM только ФОРМУЛИРУЕТ их живым языком. Если LLM не настроен
 * или недоступен (z.ai рвёт связь) — text === null, а UI показывает структурные данные.
 * Никогда не бросаем наружу и не блокируем страницу.
 *
 * 152-ФЗ: в LLM уходят только внутренние идентификаторы/агрегаты (номер заявки, модель
 * техники, статус, дни, имя инженера, причина) — БЕЗ ПДн клиента (ФИО/тел/адрес).
 */
import { and, eq } from 'drizzle-orm';
import { aiDailySummaries, withTenantTx, type Db } from '@erfolg/db';
import type { ResolvedTenant } from '../../lib/tenant';
import { todayInTimezone } from '../../lib/org-day';
import { logger } from '../../lib/logger';
import { callLlm, type LlmCallOpts } from './llm';
import { loadLlmRuntimeConfig } from './config';
import {
  BLOCKED_REASON_LABEL_RU,
  boardTickets,
  deriveEffectiveBlockedReason,
  computeStuckDays,
  getTicket,
  listEvents as repoListEvents,
} from '../tickets/repository';

/** Короткие русские подписи статусов (для промпта/таймлайна; на API нет web-словаря). */
const STATUS_LABEL_RU: Record<string, string> = {
  received: 'Принята',
  diagnostics: 'Диагностика',
  estimate: 'Смета',
  approval: 'Согласование',
  in_progress: 'В работе',
  act_pending: 'Готово к выдаче',
  closed: 'Закрыта',
  cancelled: 'Отменена',
};

/**
 * Бюджет НЕинтерактивного «формулирования»: короткий таймаут и одна доп. попытка,
 * чтобы отчёт/сводка деградировали на детерминированные данные за ~секунды, а не
 * висели до ~3 мин при тормозящем z.ai (OPS-2, аудит 2026-07-06). Интерактивный чат
 * этот путь НЕ использует — там дефолт callLlm (60с×3).
 */
const PHRASE_LLM_OPTS: LlmCallOpts = { timeoutMs: 15_000, maxAttempts: 2 };

/**
 * Сформулировать текст через LLM. НИКОГДА не бросает: не настроен/сбой → null.
 * tools=[] — простое текстовое дополнение (модель ничего не вызывает).
 * Короткий бюджет (PHRASE_LLM_OPTS) — быстрый фолбэк, страница не «висит».
 */
export async function phraseWithLlm(
  db: Db,
  tenant: ResolvedTenant,
  system: string,
  user: string,
): Promise<string | null> {
  let cfg;
  try {
    cfg = await loadLlmRuntimeConfig(db, tenant);
  } catch (err) {
    logger.warn({ err }, 'proactive: loadLlmRuntimeConfig failed');
    return null;
  }
  if (!cfg) return null;
  try {
    const reply = await callLlm(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      [],
      cfg,
      PHRASE_LLM_OPTS,
    );
    const text = reply.content?.trim();
    return text ? text : null;
  } catch (err) {
    logger.warn({ err }, 'proactive: callLlm failed');
    return null;
  }
}

/* ───────────────────────── Утренняя сводка ───────────────────────── */

export interface DailySummaryData {
  activeTotal: number;
  stuckCount: number;
  readyCount: number;
  unspecifiedCount: number;
  topStuck: Array<{
    ticketId: string;
    ticketNumber: string;
    assetModel: string | null;
    stuckDays: number;
    engineerName: string | null;
    reason: string;
  }>;
  ready: Array<{ ticketId: string; ticketNumber: string; assetModel: string | null }>;
  overloaded: Array<{ name: string; count: number }>;
}

export interface DailySummaryResult {
  date: string;
  /** Сформулированный LLM текст (null — показать структурные данные). */
  text: string | null;
  data: DailySummaryData;
}

/** Детерминированные данные сводки — из доски (активные заявки). */
export async function buildDailySummaryData(
  db: Db,
  tenant: ResolvedTenant,
): Promise<DailySummaryData> {
  const cards = await boardTickets(db, tenant.id);
  const stuck = cards.filter((c) => c.light === 'red');
  const ready = cards.filter((c) => c.effectiveReason === 'ready_for_pickup');
  const unspecified = cards.filter((c) => !c.effectiveReason && c.light !== 'green');

  const loadMap = new Map<string, { name: string; count: number }>();
  for (const c of cards) {
    if (!c.assignedEngineerId) continue;
    const e = loadMap.get(c.assignedEngineerId) ?? {
      name: c.assignedEngineerName ?? '—',
      count: 0,
    };
    e.count += 1;
    loadMap.set(c.assignedEngineerId, e);
  }
  const overloaded = [...loadMap.values()]
    .filter((e) => e.count >= 3)
    .sort((a, b) => b.count - a.count);

  return {
    activeTotal: cards.length,
    stuckCount: stuck.length,
    readyCount: ready.length,
    unspecifiedCount: unspecified.length,
    // Возвращаем расширенный список (до 100) — карточка на дашборде показывает топ-5,
    // а модалка «Подробнее» — весь список. Промпт LLM режется до 8 отдельно (renderSummaryPrompt).
    topStuck: stuck.slice(0, 100).map((c) => ({
      ticketId: c.id,
      ticketNumber: c.ticketNumber,
      assetModel: c.assetModel,
      stuckDays: c.stuckDays,
      engineerName: c.assignedEngineerName,
      reason: c.effectiveReason ? BLOCKED_REASON_LABEL_RU[c.effectiveReason] : 'причина не указана',
    })),
    ready: ready.slice(0, 100).map((c) => ({
      ticketId: c.id,
      ticketNumber: c.ticketNumber,
      assetModel: c.assetModel,
    })),
    overloaded,
  };
}

const DAILY_SUMMARY_SYSTEM =
  'Ты — ассистент сервис-центра ремонта медтехники. По внутренним данным дай короткую ' +
  'утреннюю сводку для менеджера на русском: 3–5 пунктов маркированным списком, живым языком, ' +
  'самое важное сначала (что застряло и требует действия, что готово к выдаче — позвонить клиенту, ' +
  'кто из инженеров перегружен). Используй ТОЛЬКО приведённые данные, ничего не выдумывай. ' +
  'Без вступления и заключения, только пункты.';

function renderSummaryPrompt(d: DailySummaryData): string {
  const lines: string[] = [];
  lines.push(`Активных заявок: ${d.activeTotal}.`);
  lines.push(`Застряло (красных): ${d.stuckCount}. Без указанной причины: ${d.unspecifiedCount}.`);
  lines.push(`Готово к выдаче (позвонить клиенту): ${d.readyCount}.`);
  if (d.topStuck.length) {
    lines.push('Самые застоявшиеся:');
    // В промпт LLM — только топ-8 (данные для UI-модалки шире, но токены беречь).
    for (const s of d.topStuck.slice(0, 8)) {
      lines.push(
        `  • ${s.ticketNumber} ${s.assetModel ?? ''} — стоит ${s.stuckDays} дн, ` +
          `${s.reason}${s.engineerName ? `, инженер ${s.engineerName}` : ', инженер не назначен'}.`,
      );
    }
  }
  if (d.overloaded.length) {
    lines.push('Загрузка инженеров (перегруженные):');
    for (const e of d.overloaded) lines.push(`  • ${e.name}: ${e.count} активных.`);
  }
  return lines.join('\n');
}

/**
 * Утренняя сводка: данные считаем всегда; текст LLM берём из кэша (одна строка на день),
 * иначе собираем и кэшируем. Кэш экономит вызовы LLM и не зависит от аптайма провайдера.
 */
export async function getOrBuildDailySummary(
  db: Db,
  tenant: ResolvedTenant,
): Promise<DailySummaryResult> {
  const date = todayInTimezone(tenant.timezone);
  const data = await buildDailySummaryData(db, tenant);

  const cached = await withTenantTx(db, tenant.id, (tx) =>
    tx
      .select({ body: aiDailySummaries.bodyText })
      .from(aiDailySummaries)
      .where(and(eq(aiDailySummaries.tenantId, tenant.id), eq(aiDailySummaries.summaryDate, date)))
      .limit(1),
  );
  if (cached[0]?.body) return { date, text: cached[0].body, data };

  const text = await phraseWithLlm(db, tenant, DAILY_SUMMARY_SYSTEM, renderSummaryPrompt(data));
  if (text) {
    await withTenantTx(db, tenant.id, (tx) =>
      tx
        .insert(aiDailySummaries)
        .values({ tenantId: tenant.id, summaryDate: date, bodyText: text })
        .onConflictDoNothing(),
    );
  }
  return { date, text, data };
}

/* ───────────────────── «Почему застряло?» ───────────────────── */

export interface ExplainBlockResult {
  text: string | null;
  facts: {
    ticketNumber: string;
    assetModel: string | null;
    status: string;
    reason: string | null;
    stuckDays: number;
    /** Человекочитаемый таймлайн последних событий (для фолбэка в UI). */
    timeline: string[];
  };
}

function describeEvent(e: {
  type: string;
  payload: { from?: unknown; to?: unknown; comment?: string; role?: string };
}): string {
  switch (e.type) {
    case 'created':
      return 'Заявка создана';
    case 'status_change':
      return `Статус: ${STATUS_LABEL_RU[String(e.payload.from)] ?? String(e.payload.from)} → ${
        STATUS_LABEL_RU[String(e.payload.to)] ?? String(e.payload.to)
      }`;
    case 'assignment_change':
      return e.payload.role === 'engineer' ? 'Сменился инженер' : 'Сменился диспетчер';
    case 'priority_change':
      return 'Изменён приоритет';
    case 'sla_change':
      return 'Изменён срок (SLA)';
    case 'note':
      return e.payload.comment ? `Заметка: ${e.payload.comment}` : 'Заметка';
    case 'document_printed':
      return 'Напечатан документ';
    default:
      return e.type;
  }
}

/**
 * Объяснить, почему заявка стоит. Детерминированные факты (статус, причина, простой,
 * таймлайн) — всегда; text — LLM-формулировка (или null). Только по внутренним данным.
 */
export async function explainTicketBlock(
  db: Db,
  tenant: ResolvedTenant,
  ticketId: string,
): Promise<ExplainBlockResult | null> {
  const ticket = await getTicket(db, tenant.id, ticketId);
  if (!ticket) return null;

  const events = await repoListEvents(db, tenant.id, ticketId, 20);
  const effective = deriveEffectiveBlockedReason(ticket.status, ticket.blockedReason ?? null);
  // Дней без прогресса — от последней смены статуса (события отсортированы по убыванию).
  const nowMs = Date.now();
  const lastStatusChange = events.find((e) => e.type === 'status_change');
  const anchorMs = (lastStatusChange?.createdAt ?? ticket.receivedAt).getTime();
  const stalledDays = Math.max(0, Math.floor((nowMs - anchorMs) / 86_400_000));
  const stuckDays = computeStuckDays(ticket.blockedSince ?? null, stalledDays, nowMs);
  const reasonLabel = effective ? BLOCKED_REASON_LABEL_RU[effective] : null;
  // Таймлайн — от старых к новым (listEvents отдаёт по убыванию).
  const timeline = [...events].reverse().map(describeEvent);

  const facts = {
    ticketNumber: ticket.ticketNumber,
    assetModel: ticket.assetModel,
    status: STATUS_LABEL_RU[ticket.status] ?? ticket.status,
    reason: reasonLabel,
    stuckDays,
    timeline,
  };

  const promptLines = [
    `Заявка ${facts.ticketNumber}, техника: ${facts.assetModel ?? 'не указана'}.`,
    `Текущий статус: ${facts.status}. Стоит без движения: ${stuckDays} дн.`,
    reasonLabel ? `Причина простоя: ${reasonLabel}.` : 'Причина простоя не указана.',
    'История (от старых к новым):',
    ...timeline.map((t) => `  • ${t}`),
  ];
  const system =
    'Ты — ассистент сервис-центра ремонта медтехники. Объясни менеджеру простым языком, ' +
    'почему заявка стоит и что сделать дальше. 2–4 коротких предложения. Используй ТОЛЬКО ' +
    'данные ниже, ничего не выдумывай. Заверши конкретным следующим шагом.';
  const text = await phraseWithLlm(db, tenant, system, promptLines.join('\n'));

  return { text, facts };
}
