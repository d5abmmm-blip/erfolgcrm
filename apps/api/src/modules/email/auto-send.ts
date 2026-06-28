/**
 * Отправка АВТО-писем воркерами (уведомления о статусе заявки, напоминания по счетам)
 * от имени tenant'а.
 *
 * Единый источник транспорта — ящик из email_configs (тот же, что у раздела «Почта»).
 * Раньше воркеры слали через ENV SMTP_*, который на проде пуст → письма молча skipped.
 * Теперь: берём ящик tenant'а; если он не настроен/выключен ИЛИ загрузка конфига упала —
 * фолбэк на ENV (поведение прежнего sendMail). Так авто-письма работают без дублирования
 * кредов в ENV. См. docs/handover-fixes-2026-06-28.md и memory final_audit_2026_06_28.
 */
import { getTenantEncryptionKey, type Db } from '@erfolg/db';
import { logger } from '../../lib/logger';
import {
  sendMailVia,
  type SendMailInput,
  type SendMailResult,
  type SmtpTransport,
} from '../../lib/mailer';
import { getTransportConfig } from './repository';

export async function sendMailForTenant(
  db: Db,
  tenantId: string,
  input: SendMailInput,
): Promise<SendMailResult> {
  let transport: SmtpTransport | null = null;
  try {
    const key = getTenantEncryptionKey({ id: tenantId, kmsKeyId: null });
    const cfg = await getTransportConfig(db, tenantId, key);
    if (cfg && cfg.enabled && cfg.host) {
      transport = {
        host: cfg.host,
        port: cfg.port ?? 587,
        secure: cfg.secure,
        user: cfg.user,
        pass: cfg.password,
        from: cfg.from,
      };
    }
  } catch (err) {
    logger.warn(
      { err, tenantId },
      'sendMailForTenant: не удалось загрузить ящик tenant, фолбэк на ENV SMTP_*',
    );
  }
  // transport === null → sendMailVia уходит на ENV-транспорт (как прежний sendMail).
  return sendMailVia(transport, input);
}
