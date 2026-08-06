/**
 * Воркер email-уведомлений клиента при смене статуса заявки.
 *
 * Бизнес-цель: устранить ~30% звонков «когда готово?». Клиент видит письмо
 * при ключевых статусах (received / diagnostics / estimate / in_progress /
 * act_pending / closed / cancelled). Транзитные (approval) — пропускаем,
 * чтобы не превращать почту в шум.
 *
 * Контракт:
 *   - Продюсер вызывает enqueueTicketStatusNotify(payload) внутри changeStatusCmd
 *     ПОСЛЕ успешной мутации (не блокирует мутацию).
 *   - Воркер тянет тикет/клиента/asset/engineer/tenant, формирует письмо и
 *     отправляет через sendMail. Если у клиента нет email — skip с logger.info.
 *   - PII в логах маскируем (maskEmail).
 */
import { eq } from 'drizzle-orm';
import type { TicketStatus } from '@erfolg/shared';
import { assets, clients, getDb, tenants, tickets, users, withTenantTx } from '@erfolg/db';
import { logger } from '../lib/logger';
import { normalizeEmailAddress } from '../lib/email-address';
import { maskEmail } from '../lib/mask';
import { sendMailForTenant } from '../modules/email/auto-send';
import { tryJournalEmail } from '../lib/email-journal';
import { getQueue, registerWorker } from '../lib/queue';
import { getOrCreateTrackToken } from '../modules/tickets/repository';
import { buildTrackUrl } from '../lib/public-url';
import {
  renderTicketStatusEmail,
  shouldIncludeTrackLink,
  shouldNotifyClient,
} from '../lib/email-templates/ticket-status';

const QUEUE_NAME = 'ticket-status-notify';
const JOB_NAME = 'notify';

export interface TicketStatusNotifyPayload {
  tenantId: string;
  ticketId: string;
  oldStatus: TicketStatus;
  newStatus: TicketStatus;
}

export interface TicketStatusNotifyResult {
  status: 'sent' | 'skipped';
  reason?: string;
}

/** Продюсер: ставим job в очередь после успешной смены статуса. */
export async function enqueueTicketStatusNotify(payload: TicketStatusNotifyPayload): Promise<void> {
  await getQueue<TicketStatusNotifyPayload>(QUEUE_NAME).add(JOB_NAME, payload, {
    // Дедуп: одинаковый ticket+to за короткий промежуток не должен залить клиента.
    // ВАЖНО: BullMQ запрещает ':' в custom jobId (молча отвергает job) → только дефис.
    jobId: `notify-${payload.tenantId}-${payload.ticketId}-${payload.newStatus}`,
  });
}

interface LoadedTicket {
  ticketNumber: string;
  symptom: string | null;
  cancelReason: string | null;
  clientId: string;
  clientType: 'legal' | 'individual';
  clientDisplayName: string;
  clientEmail: string | null;
  individualFullName: string | null;
  assetModel: string | null;
  engineerFullName: string | null;
  /** Фича B — guard идемпотентности уведомления «готово к выдаче». */
  readyNotifiedAt: Date | null;
}

async function loadTicketDetails(tenantId: string, ticketId: string): Promise<LoadedTicket | null> {
  return withTenantTx(getDb(), tenantId, async (tx) => {
    const rows = await tx
      .select({
        ticketNumber: tickets.ticketNumber,
        symptom: tickets.symptom,
        cancelReason: tickets.cancelReason,
        clientId: tickets.clientId,
        clientType: clients.type,
        clientDisplayName: clients.displayName,
        clientEmail: clients.email,
        individualFullName: clients.individualFullName,
        assetModel: assets.model,
        engineerFullName: users.fullName,
        readyNotifiedAt: tickets.readyNotifiedAt,
      })
      .from(tickets)
      .leftJoin(clients, eq(tickets.clientId, clients.id))
      .leftJoin(assets, eq(tickets.assetId, assets.id))
      .leftJoin(users, eq(tickets.assignedEngineerId, users.id))
      .where(eq(tickets.id, ticketId))
      .limit(1);
    const r = rows[0];
    if (!r || !r.clientType) return null;
    return {
      ticketNumber: r.ticketNumber,
      symptom: r.symptom,
      cancelReason: r.cancelReason,
      clientId: r.clientId,
      clientType: r.clientType,
      clientDisplayName: r.clientDisplayName ?? '',
      clientEmail: r.clientEmail,
      individualFullName: r.individualFullName,
      assetModel: r.assetModel,
      engineerFullName: r.engineerFullName,
      readyNotifiedAt: r.readyNotifiedAt,
    };
  });
}

/**
 * Фича B — тумблер tenant'а на письмо «техника готова». tenants — control-plane без RLS,
 * читаем напрямую. По умолчанию true (прод уже шлёт это письмо — поведение не меняем);
 * директор может отключить в Настройках → Уведомления клиентам.
 */
async function isReadyNotifyEnabled(tenantId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ enabled: tenants.notifyClientWhenReady })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return rows[0]?.enabled ?? true;
}

/** Фича B — отметить, что письмо «готово» по заявке уже отправлено (guard идемпотентности). */
async function markReadyNotified(tenantId: string, ticketId: string): Promise<void> {
  await withTenantTx(getDb(), tenantId, async (tx) => {
    await tx.update(tickets).set({ readyNotifiedAt: new Date() }).where(eq(tickets.id, ticketId));
  });
}

async function loadTenantDisplayName(tenantId: string): Promise<string> {
  const rows = await getDb()
    .select({ displayName: tenants.displayName, legalName: tenants.legalName })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const t = rows[0];
  if (!t) return 'Сервисный центр';
  return t.legalName ?? t.displayName;
}

/** Кому шлём письмо: для физлица берём его «индивидуальный» email из clients.email
 *  (он plain text — см. schema/clients.ts), для юрлица — рабочий email организации.
 *
 *  Проверки «поле не пустое» здесь НЕДОСТАТОЧНО. Из старой системы (WinServisePro) в это
 *  поле приехал свободный текст — имена и телефоны; на проде 2026-07-22 из 43 непустых
 *  значений 39 были без «@». Такой мусор доезжал до nodemailer, тот падал с
 *  `No recipients defined`, BullMQ уводил задачу в ретраи — и пять смен статуса за утро
 *  дали 24 ошибки в логах. */
function resolveRecipient(loaded: LoadedTicket): string | null {
  return normalizeEmailAddress(loaded.clientEmail);
}

/** Есть ли в карточке хоть что-то в поле почты. Нужно, чтобы отличить «почта не указана»
 *  от «указано, но это не адрес»: во втором случае чинить надо КАРТОЧКУ КЛИЕНТА, и
 *  причина пропуска должна об этом говорить. */
function hasEmailValue(loaded: LoadedTicket): boolean {
  return (loaded.clientEmail ?? '').trim().length > 0;
}

/** Имя клиента для приветствия. Для физлица — расшифрованное ФИО (если есть),
 *  иначе display_name (инициалы). Для юрлица — display_name. */
function resolveGreetingName(loaded: LoadedTicket): string {
  if (loaded.clientType === 'individual' && loaded.individualFullName) {
    return loaded.individualFullName;
  }
  return loaded.clientDisplayName || 'клиент';
}

export async function processTicketStatusNotify(
  payload: TicketStatusNotifyPayload,
): Promise<TicketStatusNotifyResult> {
  if (!shouldNotifyClient(payload.newStatus)) {
    return { status: 'skipped', reason: 'status-not-notifiable' };
  }

  // Фича B — «техника готова к выдаче» = переход в act_pending. Это письмо уже слалось
  // воркером и раньше; теперь его можно ОТКЛЮЧИТЬ тумблером tenant'а (по умолчанию ВКЛ,
  // чтобы прод-поведение не изменилось). Если тумблер выключен — для act_pending не шлём.
  const isReadyNotification = payload.newStatus === 'act_pending';
  if (isReadyNotification) {
    const enabled = await isReadyNotifyEnabled(payload.tenantId);
    if (!enabled) {
      return { status: 'skipped', reason: 'ready-notify-disabled' };
    }
  }

  const loaded = await loadTicketDetails(payload.tenantId, payload.ticketId);
  if (!loaded) {
    logger.info(
      { ticketId: payload.ticketId, tenantId: payload.tenantId },
      'ticket-status-notify: ticket not found',
    );
    return { status: 'skipped', reason: 'ticket-not-found' };
  }

  // Фича B — идемпотентность: письмо «готово» по одной заявке шлём один раз
  // (guard ready_notified_at). Защищает от повторов act_pending → in_progress → act_pending.
  if (isReadyNotification && loaded.readyNotifiedAt) {
    logger.info(
      { ticketId: payload.ticketId, ticketNumber: loaded.ticketNumber },
      'ticket-status-notify: ready already notified, skipping',
    );
    return { status: 'skipped', reason: 'ready-already-notified' };
  }

  const to = resolveRecipient(loaded);
  if (!to) {
    // Само значение в лог НЕ пишем — там лежит ФИО клиента (ПДн). Пишем clientId,
    // по нему карточку находят и правят.
    if (hasEmailValue(loaded)) {
      logger.info(
        {
          ticketId: payload.ticketId,
          ticketNumber: loaded.ticketNumber,
          clientId: loaded.clientId,
        },
        'ticket-status-notify: client email is not an address, skipping',
      );
      return { status: 'skipped', reason: 'invalid-email' };
    }
    logger.info(
      { ticketId: payload.ticketId, ticketNumber: loaded.ticketNumber },
      'ticket-status-notify: client has no email, skipping',
    );
    return { status: 'skipped', reason: 'no-email' };
  }

  const tenantName = await loadTenantDisplayName(payload.tenantId);

  // Фича №1 (трек-ссылка в письме) — только для ключевых статусов
  // (принята / ремонт / готова к выдаче). Токен идемпотентный: если менеджер уже
  // выдавал ссылку клиенту — тот же токен; иначе создаётся здесь. Любой сбой
  // (или ненастроенный API_PUBLIC_URL) деградирует до письма БЕЗ ссылки — не роняем уведомление.
  let trackUrl: string | null = null;
  if (shouldIncludeTrackLink(payload.newStatus)) {
    try {
      const token = await getOrCreateTrackToken(getDb(), payload.tenantId, payload.ticketId);
      trackUrl = buildTrackUrl(token);
    } catch (err) {
      logger.warn(
        { err, ticketId: payload.ticketId, ticketNumber: loaded.ticketNumber },
        'ticket-status-notify: track token failed, sending without link',
      );
    }
  }

  const rendered = renderTicketStatusEmail({
    ticketNumber: loaded.ticketNumber,
    newStatus: payload.newStatus,
    clientDisplayName: resolveGreetingName(loaded),
    assetModel: loaded.assetModel,
    symptom: loaded.symptom,
    engineerFullName: loaded.engineerFullName,
    cancelReason: loaded.cancelReason,
    tenantDisplayName: tenantName,
    trackUrl,
  });

  try {
    const result = await sendMailForTenant(getDb(), payload.tenantId, {
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    if (result.skipped) {
      logger.info(
        { to: maskEmail(to), reason: result.reason, ticketNumber: loaded.ticketNumber },
        'ticket-status-notify: send skipped',
      );
      await tryJournalEmail(getDb(), payload.tenantId, {
        direction: 'out',
        status: 'skipped',
        to,
        subject: rendered.subject,
        bodyText: rendered.text,
        bodyHtml: rendered.html,
        relatedTicketId: payload.ticketId,
        relatedClientId: loaded.clientId,
      });
      return { status: 'skipped', reason: result.reason ?? 'mailer-skipped' };
    }
    logger.info(
      {
        to: maskEmail(to),
        ticketNumber: loaded.ticketNumber,
        newStatus: payload.newStatus,
      },
      'ticket-status-notify: sent',
    );
    await tryJournalEmail(getDb(), payload.tenantId, {
      direction: 'out',
      status: 'sent',
      to,
      subject: rendered.subject,
      bodyText: rendered.text,
      bodyHtml: rendered.html,
      messageId: result.messageId ?? null,
      relatedTicketId: payload.ticketId,
      relatedClientId: loaded.clientId,
      sentAt: new Date(),
    });
    // Фича B — ставим guard ПОСЛЕ успешной отправки «готово», чтобы повторно не слать.
    if (isReadyNotification) {
      await markReadyNotified(payload.tenantId, payload.ticketId);
    }
    return { status: 'sent' };
  } catch (err) {
    logger.warn(
      { err, to: maskEmail(to), ticketId: payload.ticketId },
      'ticket-status-notify: send failed',
    );
    throw err;
  }
}

export function registerTicketStatusNotifyWorker(): void {
  registerWorker<TicketStatusNotifyPayload, TicketStatusNotifyResult>({
    name: QUEUE_NAME,
    concurrency: 4,
    processor: async (job) => processTicketStatusNotify(job.data),
  });
}

/** Имя очереди — экспортируется для тестов. */
export const TICKET_STATUS_NOTIFY_QUEUE = QUEUE_NAME;
