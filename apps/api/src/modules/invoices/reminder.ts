/**
 * Общий код письма-напоминания о просроченном счёте.
 *
 * Одна точка сборки темы/текста + отправки + журналирования + отметки reminderCount.
 * Её используют И ночной воркер invoice-reminder (авто-напоминания раз в неделю),
 * И ручная кнопка «Напомнить» на экране «Дебиторка» (invoices.sendReminder).
 *
 * Раньше вся эта логика жила внутри воркера — вынесли, чтобы ручная отправка шла тем же
 * проверенным путём (без дубля кода письма). Функция НЕ проверяет cooldown и статус —
 * это ответственность вызывающего: воркер фильтрует по cooldown (listOverdueForReminder),
 * ручная кнопка — по «есть просроченные счета» (listClientOverdueInvoices).
 */
import { eq } from 'drizzle-orm';
import { clients, tenants, withTenantTx, type Db } from '@erfolg/db';
import { logger } from '../../lib/logger';
import { sendMailForTenant } from '../email/auto-send';
import { tryJournalEmail } from '../../lib/email-journal';
import { markReminderSent, type InvoiceDto } from './repository';

/** Исход одной попытки напоминания. */
export type ReminderOutcome = 'sent' | 'skipped_no_email' | 'skipped_mail' | 'error';

export interface ReminderResult {
  invoiceId: string;
  outcome: ReminderOutcome;
  messageId?: string | null;
}

/** Копейки (строка bigint) → «1234.56» для тела письма. */
function kopecksToRub(kopecks: string): string {
  const n = BigInt(kopecks);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const rub = abs / 100n;
  const cop = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${rub.toString()}.${cop}`;
}

function reminderSubject(invoiceNumber: string): string {
  return `Просроченный счёт № ${invoiceNumber}`;
}

function reminderText(args: {
  invoiceNumber: string;
  totalRub: string;
  paidRub: string;
  dueDate: string;
  tenantName: string;
}): string {
  return [
    `Здравствуйте.`,
    ``,
    `Напоминаем, что счёт № ${args.invoiceNumber} от ${args.tenantName} на сумму ${args.totalRub} ₽`,
    `(оплачено ${args.paidRub} ₽) просрочен. Срок оплаты — ${args.dueDate}.`,
    ``,
    `Просим оплатить в ближайшее время. Если оплата уже прошла — игнорируйте это письмо.`,
    ``,
    `С уважением,`,
    `${args.tenantName}`,
  ].join('\n');
}

/** Название компании-tenant'а для подписи письма (control plane, без RLS). */
export async function getTenantDisplayName(db: Db, tenantId: string): Promise<string> {
  const rows = await db
    .select({ displayName: tenants.displayName, legalName: tenants.legalName })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const r = rows[0];
  return r?.legalName ?? r?.displayName ?? 'Сервисный центр';
}

/** Email клиента (plain-поле), null если не задан. */
async function getClientEmail(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ email: clients.email })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return rows[0]?.email ?? null;
  });
}

/**
 * Отправляет одно письмо-напоминание по счёту: resolve email → send → journal → markReminderSent.
 * Возвращает исход (для статистики воркера и тоста на кнопке). dryRun не шлёт реально.
 * Ошибку отправки НЕ пробрасывает (ловит внутри) — возвращает outcome='error', чтобы один
 * плохой счёт не рушил цикл по остальным.
 */
export async function sendInvoiceReminder(
  db: Db,
  tenant: { id: string; name: string },
  invoice: InvoiceDto,
  opts: { dryRun: boolean },
): Promise<ReminderResult> {
  const email = await getClientEmail(db, tenant.id, invoice.clientId);
  if (!email) {
    // Без email напомнить нельзя — reminderCount НЕ трогаем, чтобы как только email
    // появится, напоминание ушло.
    return { invoiceId: invoice.id, outcome: 'skipped_no_email' };
  }
  const subject = reminderSubject(invoice.invoiceNumber);
  const text = reminderText({
    invoiceNumber: invoice.invoiceNumber,
    totalRub: kopecksToRub(invoice.totalAmountKopecks),
    paidRub: kopecksToRub(invoice.paidAmountKopecks),
    dueDate: invoice.dueDate,
    tenantName: tenant.name,
  });
  try {
    const result = await sendMailForTenant(db, tenant.id, {
      to: email,
      subject,
      text,
      dryRun: opts.dryRun,
    });
    if (result.skipped) {
      await tryJournalEmail(db, tenant.id, {
        direction: 'out',
        status: 'skipped',
        to: email,
        subject,
        bodyText: text,
        relatedClientId: invoice.clientId,
      });
      return { invoiceId: invoice.id, outcome: 'skipped_mail' };
    }
    await markReminderSent(db, tenant.id, invoice.id);
    await tryJournalEmail(db, tenant.id, {
      direction: 'out',
      status: 'sent',
      to: email,
      subject,
      bodyText: text,
      messageId: result.messageId ?? null,
      relatedClientId: invoice.clientId,
      sentAt: new Date(),
    });
    return { invoiceId: invoice.id, outcome: 'sent', messageId: result.messageId ?? null };
  } catch (err) {
    logger.warn(
      { err, invoiceId: invoice.id, tenantId: tenant.id },
      'invoice reminder: send failed',
    );
    return { invoiceId: invoice.id, outcome: 'error' };
  }
}
