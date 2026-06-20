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
import {
  assets,
  clients,
  decryptSql,
  getDb,
  getTenantEncryptionKey,
  tenants,
  tickets,
  users,
  withTenantTx,
} from '@erfolg/db';
import { logger } from '../lib/logger';
import { maskEmail } from '../lib/mask';
import { sendMail } from '../lib/mailer';
import { tryJournalEmail } from '../lib/email-journal';
import { getQueue, registerWorker } from '../lib/queue';
import {
  renderTicketStatusEmail,
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
export async function enqueueTicketStatusNotify(
  payload: TicketStatusNotifyPayload,
): Promise<void> {
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
}

async function loadTicketDetails(
  tenantId: string,
  ticketId: string,
): Promise<LoadedTicket | null> {
  const key = getTenantEncryptionKey({ id: tenantId, kmsKeyId: null });
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
        individualFullName: decryptSql(clients.fullNameEncrypted, key).as(
          'full_name_dec',
        ),
        assetModel: assets.model,
        engineerFullName: users.fullName,
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
      individualFullName: (r.individualFullName as string | null) ?? null,
      assetModel: r.assetModel,
      engineerFullName: r.engineerFullName,
    };
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
 *  (он plain text — см. schema/clients.ts), для юрлица — рабочий email организации. */
function resolveRecipient(loaded: LoadedTicket): string | null {
  return loaded.clientEmail && loaded.clientEmail.trim().length > 0
    ? loaded.clientEmail.trim()
    : null;
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
  // TODO: notify_status_changes колонку добавим отдельной миграцией; пока
  // считаем, что клиент согласен на уведомления (true). Опт-аут реализуем
  // вместе с UI-настройкой клиента.
  const notifyStatusChanges = true;
  if (!notifyStatusChanges) return { status: 'skipped', reason: 'opt-out' };

  const loaded = await loadTicketDetails(payload.tenantId, payload.ticketId);
  if (!loaded) {
    logger.info(
      { ticketId: payload.ticketId, tenantId: payload.tenantId },
      'ticket-status-notify: ticket not found',
    );
    return { status: 'skipped', reason: 'ticket-not-found' };
  }

  const to = resolveRecipient(loaded);
  if (!to) {
    logger.info(
      { ticketId: payload.ticketId, ticketNumber: loaded.ticketNumber },
      'ticket-status-notify: client has no email, skipping',
    );
    return { status: 'skipped', reason: 'no-email' };
  }

  const tenantName = await loadTenantDisplayName(payload.tenantId);
  const rendered = renderTicketStatusEmail({
    ticketNumber: loaded.ticketNumber,
    newStatus: payload.newStatus,
    clientDisplayName: resolveGreetingName(loaded),
    assetModel: loaded.assetModel,
    symptom: loaded.symptom,
    engineerFullName: loaded.engineerFullName,
    cancelReason: loaded.cancelReason,
    tenantDisplayName: tenantName,
  });

  try {
    const result = await sendMail({
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
