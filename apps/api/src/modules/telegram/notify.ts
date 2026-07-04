/**
 * Исходящие Telegram-нуджи сотрудникам через tenant-бота.
 *
 * Best-effort: нет конфига бота / бот выключен / чат не привязан / сеть упала —
 * возвращаем { sent: false, reason }, НИКОГДА не бросаем. Вызывающий (воркер)
 * сам решает, дублировать ли в web-push.
 *
 * 152-ФЗ: в текст нуджа НЕ включаем ПДн клиента (ФИО/телефон/адрес) — только
 * номер заявки, модель техники, время и причина. Детали — по кнопке в СРМ.
 */
import type { Db } from '@erfolg/db';
import { logger } from '../../lib/logger';
import { sendMessage, type TgInlineKeyboard } from '../../lib/telegram-client';
import { getSecretConfig } from './repository';
import { getChatIdForUser } from './staff-link';

/** Кнопки реакции по заявке: callback_data = r:<act>:<ticketId> (≤64 байт). */
export type ReactAction = 'iw' | 'rd' | 'pt' | 'ot';

export const REACT_BUTTON_LABELS: Record<ReactAction, string> = {
  iw: 'Ещё в работе',
  rd: 'Готово к выдаче',
  pt: 'Жду запчасть',
  ot: 'Другое — отвечу текстом',
};

export function buildReactKeyboard(ticketId: string): TgInlineKeyboard {
  const row = (act: ReactAction) => [
    { text: REACT_BUTTON_LABELS[act], callback_data: `r:${act}:${ticketId}` },
  ];
  return { inline_keyboard: [row('iw'), row('rd'), row('pt'), row('ot')] };
}

export interface StaffNotifyResult {
  sent: boolean;
  reason?: 'no_bot' | 'bot_disabled' | 'not_linked' | 'send_failed';
}

export async function sendTelegramToUser(
  db: Db,
  tenant: { id: string; kmsKeyId: string | null },
  userId: string,
  text: string,
  replyMarkup?: TgInlineKeyboard,
): Promise<StaffNotifyResult> {
  try {
    const cfg = await getSecretConfig(db, tenant);
    if (!cfg) return { sent: false, reason: 'no_bot' };
    if (!cfg.enabled) return { sent: false, reason: 'bot_disabled' };
    const chatId = await getChatIdForUser(db, tenant.id, userId);
    if (chatId == null) return { sent: false, reason: 'not_linked' };
    const res = await sendMessage(cfg.botToken, {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    });
    if (!res.ok) {
      logger.warn(
        { tenantId: tenant.id, userId, description: res.description },
        'telegram staff notify rejected',
      );
      return { sent: false, reason: 'send_failed' };
    }
    return { sent: true };
  } catch (err: unknown) {
    logger.warn({ err, tenantId: tenant.id, userId }, 'telegram staff notify failed');
    return { sent: false, reason: 'send_failed' };
  }
}
