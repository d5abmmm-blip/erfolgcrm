/**
 * Воркер нуджей инженерам: «СРМ сама тыкает, инженер отвечает одной кнопкой».
 *
 * Тик каждые 15 минут (ENGINEER_NUDGE_CRON), по каждому активному tenant'у:
 *   1. Утренний план (8:30–10:00 рабочего дня, 1 раз в день, только если есть
 *      выезды или провисшие заявки).
 *   2. Напоминание о выезде — за ~час до tickets.scheduled_start_at.
 *   3. «Что с заявкой?» — заявка инженера стоит ≥ BOARD_WARN_DAYS без причины:
 *      не чаще раза в 2 дня по заявке, ≤ NUDGE_DAILY_LIMIT в день на инженера,
 *      только в рабочее время 9:00–18:00 (таймзона организации).
 *
 * Каналы: Telegram (кнопки) — основной; web-push (кнопки в уведомлении) — фолбэк,
 * если чат не привязан или бот молчит. Решения «что слать» — детерминированные
 * правила (те же пороги, что светофор доски); LLM только формулирует текст и
 * деградирует до шаблона (phraseWithLlm → null). ПДн клиента в тексты не попадают.
 *
 * Дедуп/лимиты — Redis (lib/nudge-state.ts). Счётчик неответов читает stuck-alert.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, pushSubscriptions, tenants, users, withTenantTx } from '@erfolg/db';
import { logger } from '../lib/logger';
import { getQueue, registerWorker } from '../lib/queue';
import {
  getDailyCount,
  incrUnansweredCount,
  NUDGE_DAILY_LIMIT,
  tryAcquireAskSlot,
  tryAcquireDailySlot,
  tryMarkMorningSent,
  tryMarkVisitReminderSent,
} from '../lib/nudge-state';
import type { ResolvedTenant } from '../lib/tenant';
import { enqueuePushToUser } from '../modules/notifications';
import { phraseWithLlm } from '../modules/ai-assistant/proactive';
import { buildReactKeyboard, sendTelegramToUser } from '../modules/telegram/notify';
import {
  BOARD_WARN_DAYS,
  boardTickets,
  repoWeeklySchedule,
  type BoardTicketDto,
  type ScheduledTicketDto,
} from '../modules/tickets/repository';

const QUEUE_NAME = 'engineer-nudge';
const REPEAT_JOB_ID = 'engineer-nudge:tick';
const TICK_JOB_NAME = 'tick';

/** Окна в минутах локального дня организации. */
const MORNING_FROM_MIN = 8 * 60 + 30;
const MORNING_TO_MIN = 10 * 60;
const WORK_FROM_MIN = 9 * 60;
const WORK_TO_MIN = 18 * 60;
/** Напоминание о выезде: за 45–75 минут до начала (тик каждые 15 мин). */
const VISIT_REMIND_FROM_MIN = 45;
const VISIT_REMIND_TO_MIN = 75;

interface TickPayload {
  reason: 'cron' | 'manual';
}

export interface EngineerNudgeStats {
  tenants: number;
  morningSent: number;
  visitSent: number;
  askSent: number;
  viaTelegram: number;
  viaPush: number;
}

/** Активные tenant'ы целиком (нужны timezone и kmsKeyId для LLM/бота). */
async function listActiveTenants(): Promise<ResolvedTenant[]> {
  const rows = await getDb()
    .select({
      id: tenants.id,
      subdomain: tenants.subdomain,
      displayName: tenants.displayName,
      status: tenants.status,
      timezone: tenants.timezone,
      kmsKeyId: tenants.kmsKeyId,
    })
    .from(tenants);
  return rows.filter((r) => r.status === 'active');
}

/** YYYY-MM-DD в таймзоне организации. */
export function dateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Минута локального дня (0..1439) в таймзоне организации. */
export function minutesOfDayInTz(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

/** Рабочий день (пн–пт) в таймзоне организации. Праздники РФ не учитываем (v1). */
export function isWorkdayInTz(d: Date, tz: string): boolean {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  return wd !== 'Sat' && wd !== 'Sun';
}

/** ЧЧ:ММ в таймзоне организации — для текста «выезд в 10:00». */
export function timeInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/**
 * Кандидаты на вопрос «что с заявкой?» — те же пороги, что жёлтый светофор доски.
 * received намеренно НЕ нуджим: для него кнопки «готово/запчасть» бессмысленны
 * (работа не начата), а застрявший received менеджер видит на доске и в stuck-alert.
 */
export function pickAskCandidates(cards: BoardTicketDto[]): BoardTicketDto[] {
  return cards
    .filter(
      (c) =>
        c.assignedEngineerId != null &&
        c.effectiveReason == null &&
        c.stuckDays >= BOARD_WARN_DAYS &&
        (c.status === 'diagnostics' || c.status === 'in_progress'),
    )
    .sort((a, b) => b.stuckDays - a.stuckDays);
}

interface NudgeChannelResult {
  viaTelegram: boolean;
  /** Реально ли нудж куда-то ушёл (Telegram или есть живые push-подписки). */
  delivered: boolean;
}

/** Есть ли у пользователя хоть одна живая web-push подписка. */
async function hasActivePushSubscription(tenantId: string, userId: string): Promise<boolean> {
  const rows = await withTenantTx(getDb(), tenantId, (tx) =>
    tx
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)))
      .limit(1),
  );
  return rows.length > 0;
}

/**
 * Отправить нудж: Telegram — основной канал; web-push — фолбэк (не дублируем,
 * чтобы инженер не получал одно и то же дважды). delivered=false, если у
 * инженера нет ни привязанного Telegram, ни push-подписок — тогда счётчик
 * «не ответил» НЕ инкрементим (нельзя эскалировать за неполученный нудж).
 */
async function deliverNudge(
  tenant: ResolvedTenant,
  userId: string,
  text: string,
  opts: {
    ticketIdForButtons?: string;
    pushTitle: string;
    pushUrl: string;
    pushTag: string;
    pushActions?: boolean;
  },
): Promise<NudgeChannelResult> {
  const tg = await sendTelegramToUser(
    getDb(),
    tenant,
    userId,
    text,
    opts.ticketIdForButtons ? buildReactKeyboard(opts.ticketIdForButtons) : undefined,
  );
  if (tg.sent) return { viaTelegram: true, delivered: true };

  const canPush = await hasActivePushSubscription(tenant.id, userId);
  await enqueuePushToUser({
    tenantId: tenant.id,
    userId,
    payload: {
      title: opts.pushTitle,
      body: text,
      url: opts.pushUrl,
      tag: opts.pushTag,
      data:
        opts.pushActions && opts.ticketIdForButtons
          ? { ticketId: opts.ticketIdForButtons, kind: 'engineer-nudge', actions: true }
          : { kind: 'engineer-nudge' },
    },
  });
  return { viaTelegram: false, delivered: canPush };
}

const MORNING_SYSTEM =
  'Ты — ассистент сервис-центра ремонта медтехники. Составь короткий утренний план ' +
  'инженеру на русском: приветствие одной фразой и 2–4 пункта списком. Обращайся на «вы». ' +
  'Используй ТОЛЬКО приведённые данные, ничего не выдумывай. Без заключения.';

const ASK_SYSTEM =
  'Ты — ассистент сервис-центра ремонта медтехники. Сформулируй короткое (1–2 предложения) ' +
  'дружелюбное напоминание инженеру: заявка давно стоит, спроси, что с ней. Обращайся на «вы». ' +
  'Используй ТОЛЬКО приведённые данные, ничего не выдумывай. Без приветствий и подписей.';

export async function processEngineerNudgeTick(now = new Date()): Promise<EngineerNudgeStats> {
  const stats: EngineerNudgeStats = {
    tenants: 0,
    morningSent: 0,
    visitSent: 0,
    askSent: 0,
    viaTelegram: 0,
    viaPush: 0,
  };
  const tenantsList = await listActiveTenants();

  for (const tenant of tenantsList) {
    stats.tenants++;
    try {
      await processTenant(tenant, now, stats);
    } catch (err) {
      logger.warn({ err, tenantId: tenant.id }, 'engineer-nudge: tenant tick failed');
    }
  }

  if (stats.morningSent + stats.visitSent + stats.askSent > 0) {
    logger.info(stats, 'engineer-nudge tick complete');
  }
  return stats;
}

async function processTenant(
  tenant: ResolvedTenant,
  now: Date,
  stats: EngineerNudgeStats,
): Promise<void> {
  const tz = tenant.timezone || 'Europe/Moscow';
  const dateStr = dateInTz(now, tz);
  const minutes = minutesOfDayInTz(now, tz);
  const workday = isWorkdayInTz(now, tz);

  const db = getDb();
  const cards = await boardTickets(db, tenant.id);
  const engineers = await activeEngineers(tenant.id);
  const activeEngineerIds = new Set(engineers.map((e) => e.id));

  // Выезды: окно «вчера вечер … +24ч», день определяем по таймзоне per-элементно,
  // чтобы не считать смещение зоны руками. Отменённые/закрытые заявки отсекаем —
  // scheduled_start_at при отмене НЕ очищается, иначе инженер поедет на отменённый выезд.
  const visitsRaw = await withTenantTx(db, tenant.id, (tx) =>
    repoWeeklySchedule(tx, {
      weekStart: new Date(now.getTime() - 2 * 3600_000),
      weekEnd: new Date(now.getTime() + 24 * 3600_000),
    }),
  );
  const visits = visitsRaw.filter((v) => v.status !== 'cancelled' && v.status !== 'closed');
  const todayVisits = visits.filter((v) => dateInTz(v.scheduledStartAt, tz) === dateStr);

  // 2. Напоминания о выезде (работают и в выходной — выезд есть выезд).
  for (const v of visits) {
    if (!v.engineerId || !activeEngineerIds.has(v.engineerId)) continue;
    const deltaMin = (v.scheduledStartAt.getTime() - now.getTime()) / 60_000;
    if (deltaMin < VISIT_REMIND_FROM_MIN || deltaMin >= VISIT_REMIND_TO_MIN) continue;
    const visitDate = dateInTz(v.scheduledStartAt, tz);
    const fresh = await tryMarkVisitReminderSent(tenant.id, v.id, visitDate);
    if (!fresh) continue;
    const text =
      `Напоминаю: в ${timeInTz(v.scheduledStartAt, tz)} выезд по ${v.ticketNumber}. ` +
      'Адрес и контакты — в заявке.';
    const ch = await deliverNudge(tenant, v.engineerId, text, {
      pushTitle: `Выезд в ${timeInTz(v.scheduledStartAt, tz)}`,
      pushUrl: `/m/tickets/${v.id}`,
      pushTag: `visit-${v.id}-${visitDate}`,
    });
    stats.visitSent++;
    if (ch.viaTelegram) stats.viaTelegram++;
    else stats.viaPush++;
  }

  if (!workday) return;

  // 1. Утренний план.
  if (minutes >= MORNING_FROM_MIN && minutes < MORNING_TO_MIN) {
    for (const eng of engineers) {
      const myVisits = todayVisits.filter((v) => v.engineerId === eng.id);
      const myCards = cards.filter((c) => c.assignedEngineerId === eng.id);
      const myStuck = pickAskCandidates(myCards).filter((c) => c.assignedEngineerId === eng.id);
      if (myVisits.length === 0 && myStuck.length === 0) continue;
      const fresh = await tryMarkMorningSent(tenant.id, eng.id, dateStr);
      if (!fresh) continue;

      const text = await buildMorningText(tenant, tz, eng.fullName, myVisits, myCards, myStuck);
      const ch = await deliverNudge(tenant, eng.id, text, {
        pushTitle: 'План на сегодня',
        pushUrl: '/m/queue',
        pushTag: `morning-${dateStr}`,
      });
      stats.morningSent++;
      if (ch.viaTelegram) stats.viaTelegram++;
      else stats.viaPush++;
    }
  }

  // 3. «Что с заявкой?» — только в рабочее время.
  if (minutes >= WORK_FROM_MIN && minutes < WORK_TO_MIN) {
    const candidates = pickAskCandidates(cards);
    for (const c of candidates) {
      const engineerId = c.assignedEngineerId;
      if (!engineerId || !activeEngineerIds.has(engineerId)) continue;
      if ((await getDailyCount(tenant.id, engineerId, dateStr)) >= NUDGE_DAILY_LIMIT) continue;
      const slot = await tryAcquireAskSlot(tenant.id, c.id);
      if (!slot) continue;
      await tryAcquireDailySlot(tenant.id, engineerId, dateStr);

      const fallback =
        `${c.ticketNumber}${c.assetModel ? ` (${c.assetModel})` : ''} стоит уже ` +
        `${c.stuckDays} дн без движения. Что с ней?`;
      const llm = await phraseWithLlm(
        getDb(),
        tenant,
        ASK_SYSTEM,
        `Заявка ${c.ticketNumber}, техника: ${c.assetModel ?? 'не указана'}. ` +
          `Стоит без движения ${c.stuckDays} дн. Спроси, что с ней.`,
      );
      const text = llm ?? fallback;

      const ch = await deliverNudge(tenant, engineerId, text, {
        ticketIdForButtons: c.id,
        pushTitle: `Что с ${c.ticketNumber}?`,
        pushUrl: `/m/queue?nudge=${c.id}`,
        pushTag: `ask-${c.id}-${dateStr}`,
        pushActions: true,
      });
      // Эскалация «не ответил» честная только если нудж реально мог дойти.
      if (ch.delivered) {
        await incrUnansweredCount(tenant.id, c.id);
      }
      stats.askSent++;
      if (ch.viaTelegram) stats.viaTelegram++;
      else stats.viaPush++;
    }
  }
}

async function activeEngineers(tenantId: string): Promise<Array<{ id: string; fullName: string }>> {
  return withTenantTx(getDb(), tenantId, (tx) =>
    tx
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(and(eq(users.role, 'engineer'), eq(users.isActive, true))),
  );
}

async function buildMorningText(
  tenant: ResolvedTenant,
  tz: string,
  fullName: string,
  myVisits: ScheduledTicketDto[],
  myCards: BoardTicketDto[],
  myStuck: BoardTicketDto[],
): Promise<string> {
  const name = fullName.trim().split(/\s+/)[1] ?? fullName;
  const inWork = myCards.filter((c) => c.status === 'in_progress' || c.status === 'diagnostics');

  const lines: string[] = [`Доброе утро, ${name}. По вам на сегодня:`];
  for (const v of myVisits) {
    lines.push(`• ${timeInTz(v.scheduledStartAt, tz)} — выезд по ${v.ticketNumber}`);
  }
  if (inWork.length > 0) {
    const top = inWork
      .slice(0, 3)
      .map((c) => `${c.ticketNumber}${c.assetModel ? ` (${c.assetModel})` : ''}`)
      .join(', ');
    lines.push(`• В работе: ${top}${inWork.length > 3 ? ` и ещё ${inWork.length - 3}` : ''}`);
  }
  for (const s of myStuck.slice(0, 2)) {
    lines.push(`• ${s.ticketNumber} стоит ${s.stuckDays} дн — гляньте, что с ней`);
  }
  const fallback = lines.join('\n');

  const facts = [
    `Инженер: ${name}.`,
    myVisits.length
      ? `Выезды сегодня: ${myVisits
          .map((v) => `${timeInTz(v.scheduledStartAt, tz)} — ${v.ticketNumber}`)
          .join('; ')}.`
      : 'Выездов сегодня нет.',
    inWork.length
      ? `В работе: ${inWork.map((c) => c.ticketNumber).join(', ')}.`
      : 'В работе ничего нет.',
    myStuck.length
      ? `Провисло: ${myStuck.map((s) => `${s.ticketNumber} — ${s.stuckDays} дн`).join('; ')}.`
      : 'Провисших нет.',
  ].join('\n');

  const llm = await phraseWithLlm(getDb(), tenant, MORNING_SYSTEM, facts);
  return llm ?? fallback;
}

/** Повторяемый тик каждые 15 минут. Идемпотентно (дедуп по jobId). */
export async function enqueueEngineerNudgeSchedule(): Promise<void> {
  if (process.env.ENGINEER_NUDGE_ENABLED === 'false') return;
  const pattern = process.env.ENGINEER_NUDGE_CRON ?? '*/15 * * * *';
  await getQueue<TickPayload>(QUEUE_NAME).add(
    TICK_JOB_NAME,
    { reason: 'cron' },
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern },
      removeOnComplete: { count: 30, age: 7 * 24 * 3600 },
      removeOnFail: { count: 100, age: 30 * 24 * 3600 },
    },
  );
  logger.info({ pattern }, 'engineer-nudge cron scheduled');
}

export function registerEngineerNudgeWorker(): void {
  registerWorker<TickPayload, EngineerNudgeStats>({
    name: QUEUE_NAME,
    concurrency: 1,
    processor: async () => processEngineerNudgeTick(),
  });
}
