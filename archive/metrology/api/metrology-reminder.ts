/**
 * Воркер ежедневных напоминаний о приближающихся поверках СИ (Stage 10'.F + 10'.G).
 *
 * Каждый «тик» (раз в день, по умолчанию 09:00):
 *   1. Для каждого активного tenant'а:
 *      a. Собрать просроченные (overdue) + те, что истекают точно через 30 / 14 / 7 дней.
 *      b. Найти получателей: активные director + dispatcher с email.
 *      c. Для каждого: проверить metrology_reminder_log на сегодня, и если ещё не слали —
 *         отправить email (HTML+text) и записать в лог.
 *      d. (Опционально) отправить web-push, если у получателя есть активные подписки.
 *
 * ENV:
 *   METROLOGY_REMINDER_CRON='0 9 * * *' (каждый день в 9:00)
 *   METROLOGY_REMINDER_DRY_RUN=true     (не шлёт реально, только лог)
 *   WEB_PUBLIC_URL='http://localhost:5173' (для ссылок в письмах)
 *
 * Анти-спам: одно письмо в день на пользователя, дедуп через metrology_reminder_log
 * UNIQUE(tenant_id, user_id, sent_on, channel).
 *
 * Логика что слать:
 *   - overdue → каждый день, пока не закроют (нельзя «забыть» о просроченной СИ).
 *   - due in 30/14/7 дней → ровно в эти даты.
 *
 * Ручной запуск через tRPC `metrology.runRemindersNow` (директор-процедура).
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  getDb,
  metrologyReminderLog,
  pushSubscriptions,
  tenants,
  users,
  withTenantTx,
} from '@erfolg/db';
import { findCalibrationsDueInDays, getOverdueAndSoon, type SiRow } from '../modules/metrology';
import { logger } from '../lib/logger';
import { sendMail } from '../lib/mailer';
import { getQueue, registerWorker } from '../lib/queue';
import { sendPush } from '../lib/web-push';

const QUEUE_NAME = 'metrology-reminder';
const REPEAT_JOB_ID = 'metrology-reminder:tick';
const TICK_JOB_NAME = 'tick';

interface TickPayload {
  reason: 'cron' | 'manual';
}

export interface MetrologyReminderStats {
  tenants: number;
  remindersFor30: number;
  remindersFor14: number;
  remindersFor7: number;
  overdueCount: number;
  emailsSent: number;
  emailsSkipped: number;
  pushesSent: number;
}

interface PerTenantStats {
  tenantId: string;
  for30: SiRow[];
  for14: SiRow[];
  for7: SiRow[];
  overdue: SiRow[];
  emailsSent: number;
  emailsSkipped: number;
  pushesSent: number;
}

interface Recipient {
  id: string;
  email: string;
  fullName: string;
  role: 'director' | 'dispatcher';
}

interface TenantBrief {
  id: string;
  name: string;
  subdomain: string;
}

function dryRun(): boolean {
  return process.env.METROLOGY_REMINDER_DRY_RUN === 'true';
}

function webBaseUrl(): string {
  return (process.env.WEB_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function listActiveTenants(): Promise<TenantBrief[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: tenants.id,
      legalName: tenants.legalName,
      displayName: tenants.displayName,
      subdomain: tenants.subdomain,
      status: tenants.status,
    })
    .from(tenants);
  return rows
    .filter((r) => r.status === 'active')
    .map((r) => ({
      id: r.id,
      name: r.legalName ?? r.displayName,
      subdomain: r.subdomain,
    }));
}

async function listRecipientsForTenant(tenantId: string): Promise<Recipient[]> {
  return withTenantTx(getDb(), tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        role: users.role,
        isActive: users.isActive,
      })
      .from(users)
      .where(and(eq(users.isActive, true), isNotNull(users.email)));
    return rows
      .filter((r) => r.role === 'director' || r.role === 'dispatcher')
      .filter((r): r is typeof r & { email: string } => Boolean(r.email))
      .map((r) => ({
        id: r.id,
        email: r.email,
        fullName: r.fullName,
        role: r.role as 'director' | 'dispatcher',
      }));
  });
}

async function listActivePushesForUser(
  tenantId: string,
  userId: string,
): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
  return withTenantTx(getDb(), tenantId, async (tx) => {
    const rows = await tx
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
        userId: pushSubscriptions.userId,
        revokedAt: pushSubscriptions.revokedAt,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    return rows
      .filter((r) => r.revokedAt === null)
      .map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
  });
}

/**
 * true — уже сегодня слали этому юзеру по этому каналу.
 * Реализовано через UPSERT-trick: пытаемся вставить и ловим unique violation.
 * Это атомарно (нет TOCTOU между check и insert).
 */
async function tryReserveReminderSlot(
  tenantId: string,
  userId: string,
  channel: 'email' | 'push',
): Promise<boolean> {
  return withTenantTx(getDb(), tenantId, async (tx) => {
    const inserted = await tx
      .insert(metrologyReminderLog)
      .values({
        tenantId,
        userId,
        channel,
        sentOn: todayIso(),
      })
      .onConflictDoNothing({
        target: [
          metrologyReminderLog.tenantId,
          metrologyReminderLog.userId,
          metrologyReminderLog.sentOn,
          metrologyReminderLog.channel,
        ],
      })
      .returning({ id: metrologyReminderLog.id });
    return inserted.length > 0;
  });
}

function emailSubject(overdueCount: number, soonCount: number): string {
  if (overdueCount > 0 && soonCount > 0) {
    return `Метрология: ${overdueCount} просрочено, ${soonCount} истекают скоро`;
  }
  if (overdueCount > 0) {
    return `Метрология: ${overdueCount} СИ просрочено`;
  }
  return `Метрология: ${soonCount} СИ истекают скоро`;
}

function siLine(si: SiRow, baseUrl: string): { html: string; text: string } {
  const url = `${baseUrl}/metrology/${si.assetId}`;
  const owner = si.ownerClientName ? ` · ${si.ownerClientName}` : '';
  const sn = si.assetSerial ? ` (с/н ${si.assetSerial})` : '';
  const next = si.nextCalibrationAt ?? '—';
  return {
    html: `<li><a href="${url}">${escapeHtml(si.assetModel)}${escapeHtml(sn)}</a> — ${escapeHtml(si.typeName)}${escapeHtml(owner)}, поверка до <b>${next}</b></li>`,
    text: `  • ${si.assetModel}${sn} — ${si.typeName}${owner}, поверка до ${next} (${url})`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface BuildBodyArgs {
  recipientName: string;
  tenantName: string;
  overdue: SiRow[];
  soon7: SiRow[];
  soon14: SiRow[];
  soon30: SiRow[];
  baseUrl: string;
}

function buildEmailBody(args: BuildBodyArgs): { html: string; text: string } {
  const sections: Array<{ title: string; items: SiRow[] }> = [
    { title: 'Просрочены', items: args.overdue },
    { title: 'Истекают через 7 дней', items: args.soon7 },
    { title: 'Истекают через 14 дней', items: args.soon14 },
    { title: 'Истекают через 30 дней', items: args.soon30 },
  ].filter((s) => s.items.length > 0);

  const htmlParts: string[] = [
    `<p>Здравствуйте, ${escapeHtml(args.recipientName)}!</p>`,
    `<p>${escapeHtml(args.tenantName)} — сводка по поверкам средств измерений на ${todayIso()}:</p>`,
  ];
  const textParts: string[] = [
    `Здравствуйте, ${args.recipientName}!`,
    ``,
    `${args.tenantName} — сводка по поверкам средств измерений на ${todayIso()}:`,
    ``,
  ];

  for (const section of sections) {
    htmlParts.push(`<h3>${section.title} (${section.items.length})</h3>`);
    htmlParts.push('<ul>');
    textParts.push(`${section.title} (${section.items.length}):`);
    for (const si of section.items) {
      const line = siLine(si, args.baseUrl);
      htmlParts.push(line.html);
      textParts.push(line.text);
    }
    htmlParts.push('</ul>');
    textParts.push('');
  }

  htmlParts.push(
    `<p><a href="${args.baseUrl}/metrology">Открыть реестр СИ</a></p>`,
    `<p style="color:#888;font-size:12px">Это автоматическое уведомление ErfolgCRM.</p>`,
  );
  textParts.push(`Реестр СИ: ${args.baseUrl}/metrology`, '', '— ErfolgCRM');

  return { html: htmlParts.join('\n'), text: textParts.join('\n') };
}

async function sendPushToRecipient(
  tenantId: string,
  recipient: Recipient,
  overdueCount: number,
  soonCount: number,
  baseUrl: string,
): Promise<boolean> {
  const subs = await listActivePushesForUser(tenantId, recipient.id);
  if (subs.length === 0) return false;
  const reserved = await tryReserveReminderSlot(tenantId, recipient.id, 'push');
  if (!reserved) return false;
  const payload = {
    title: emailSubject(overdueCount, soonCount),
    body: 'Откройте реестр метрологии',
    url: `${baseUrl}/metrology`,
    tag: 'metrology-reminder',
  };
  let any = false;
  for (const sub of subs) {
    try {
      const result = await sendPush(sub, payload);
      if (result.ok) any = true;
    } catch (err) {
      logger.warn({ err, userId: recipient.id }, 'metrology push failed');
    }
  }
  return any;
}

async function deliverToRecipient(
  tenant: TenantBrief,
  recipient: Recipient,
  per: PerTenantStats,
): Promise<void> {
  const totalSoon = per.for7.length + per.for14.length + per.for30.length;
  if (per.overdue.length === 0 && totalSoon === 0) return;

  const reserved = await tryReserveReminderSlot(tenant.id, recipient.id, 'email');
  if (!reserved) {
    per.emailsSkipped++;
    return;
  }
  const baseUrl = webBaseUrl();
  const body = buildEmailBody({
    recipientName: recipient.fullName,
    tenantName: tenant.name,
    overdue: per.overdue,
    soon7: per.for7,
    soon14: per.for14,
    soon30: per.for30,
    baseUrl,
  });
  try {
    const result = await sendMail({
      to: recipient.email,
      subject: emailSubject(per.overdue.length, totalSoon),
      text: body.text,
      html: body.html,
      dryRun: dryRun(),
    });
    if (result.skipped) {
      per.emailsSkipped++;
    } else {
      per.emailsSent++;
    }
  } catch (err) {
    logger.warn(
      { err, userId: recipient.id, tenantId: tenant.id },
      'metrology-reminder: email send failed',
    );
    per.emailsSkipped++;
  }

  // Web-push (best-effort, не критично).
  try {
    const sent = await sendPushToRecipient(
      tenant.id,
      recipient,
      per.overdue.length,
      totalSoon,
      baseUrl,
    );
    if (sent) per.pushesSent++;
  } catch (err) {
    logger.warn({ err, userId: recipient.id }, 'metrology-reminder: push failed');
  }
}

export async function processMetrologyReminderTickForTenant(
  tenantId: string,
): Promise<PerTenantStats> {
  const db = getDb();
  const for30 = await findCalibrationsDueInDays(db, tenantId, 30);
  const for14 = await findCalibrationsDueInDays(db, tenantId, 14);
  const for7 = await findCalibrationsDueInDays(db, tenantId, 7);
  const { overdue } = await getOverdueAndSoon(db, tenantId, 0);

  const per: PerTenantStats = {
    tenantId,
    for30,
    for14,
    for7,
    overdue,
    emailsSent: 0,
    emailsSkipped: 0,
    pushesSent: 0,
  };

  if (for30.length || for14.length || for7.length || overdue.length) {
    logger.info(
      {
        tenantId,
        overdue: overdue.length,
        d30: for30.length,
        d14: for14.length,
        d7: for7.length,
      },
      'metrology-reminder: tenant tick',
    );
  }

  if (
    per.overdue.length === 0 &&
    per.for7.length === 0 &&
    per.for14.length === 0 &&
    per.for30.length === 0
  ) {
    return per;
  }

  // Резолвим краткие данные tenant'а (имя, subdomain) для письма.
  const tenantsList = await listActiveTenants();
  const tenant = tenantsList.find((t) => t.id === tenantId);
  if (!tenant) return per;

  const recipients = await listRecipientsForTenant(tenantId);
  for (const recipient of recipients) {
    await deliverToRecipient(tenant, recipient, per);
  }
  return per;
}

export async function processMetrologyReminderTick(): Promise<MetrologyReminderStats> {
  const stats: MetrologyReminderStats = {
    tenants: 0,
    remindersFor30: 0,
    remindersFor14: 0,
    remindersFor7: 0,
    overdueCount: 0,
    emailsSent: 0,
    emailsSkipped: 0,
    pushesSent: 0,
  };
  const tenantsList = await listActiveTenants();
  for (const t of tenantsList) {
    stats.tenants++;
    const per = await processMetrologyReminderTickForTenant(t.id);
    stats.remindersFor30 += per.for30.length;
    stats.remindersFor14 += per.for14.length;
    stats.remindersFor7 += per.for7.length;
    stats.overdueCount += per.overdue.length;
    stats.emailsSent += per.emailsSent;
    stats.emailsSkipped += per.emailsSkipped;
    stats.pushesSent += per.pushesSent;
  }
  logger.info(stats, 'metrology-reminder tick complete');
  return stats;
}

/**
 * Ставит cron-job, повторяющийся по METROLOGY_REMINDER_CRON (default '0 9 * * *').
 * Идемпотентно: BullMQ дедуплицирует по `repeat.pattern + jobId`.
 */
export async function enqueueMetrologyReminderSchedule(): Promise<void> {
  const pattern = process.env.METROLOGY_REMINDER_CRON ?? '0 9 * * *';
  await getQueue<TickPayload>(QUEUE_NAME).add(
    TICK_JOB_NAME,
    { reason: 'cron' },
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern },
      removeOnComplete: { count: 30, age: 30 * 24 * 3600 },
      removeOnFail: { count: 100, age: 90 * 24 * 3600 },
    },
  );
  logger.info({ pattern }, 'metrology-reminder cron scheduled');
}

export function registerMetrologyReminderWorker(): void {
  registerWorker<TickPayload, MetrologyReminderStats>({
    name: QUEUE_NAME,
    concurrency: 1,
    processor: async () => processMetrologyReminderTick(),
  });
}
