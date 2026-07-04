/**
 * Минимальный клиент Telegram Bot API.
 *
 * Зачем не grammy:
 *   grammy предполагает один долгоживущий Bot инстанс на токен с зарегистрированными
 *   handler'ами. У нас per-tenant токены — handler'ы пришлось бы привязывать на лету.
 *   Прямой fetch проще и контролируемей.
 *
 * Что предоставляем: sendMessage, editMessageText, answerCallbackQuery,
 * setWebhook, deleteWebhook, getMe.
 * Все методы non-throwing на сетевых ошибках возвращают { ok: false, error }.
 */
import { logger } from './logger';

const TG_BASE = 'https://api.telegram.org';

export interface TgResult<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

async function call<T>(token: string, method: string, body?: unknown): Promise<TgResult<T>> {
  const url = `${TG_BASE}/bot${token}/${method}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await res.json()) as TgResult<T>;
  } catch (err: unknown) {
    logger.warn({ err, method }, 'telegram api call failed');
    return { ok: false, description: (err as Error).message };
  }
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

export function getMe(token: string): Promise<TgResult<TgUser>> {
  return call<TgUser>(token, 'getMe');
}

/** Inline-клавиатура: ряды кнопок с callback_data (≤64 байт на кнопку). */
export interface TgInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface SendMessageInput {
  chat_id: number | string;
  text: string;
  parse_mode?: 'Markdown' | 'HTML';
  reply_markup?: TgInlineKeyboard;
}

export function sendMessage(token: string, input: SendMessageInput): Promise<TgResult<unknown>> {
  return call(token, 'sendMessage', input);
}

export interface EditMessageTextInput {
  chat_id: number | string;
  message_id: number;
  text: string;
  reply_markup?: TgInlineKeyboard;
}

/** Заменить текст сообщения (и убрать/заменить кнопки) после нажатия. */
export function editMessageText(
  token: string,
  input: EditMessageTextInput,
): Promise<TgResult<unknown>> {
  return call(token, 'editMessageText', input);
}

/** Погасить «часики» на нажатой inline-кнопке (обязателен ответ на каждый callback). */
export function answerCallbackQuery(
  token: string,
  input: { callback_query_id: string; text?: string; show_alert?: boolean },
): Promise<TgResult<boolean>> {
  return call<boolean>(token, 'answerCallbackQuery', input);
}

export interface SetWebhookInput {
  url: string;
  secret_token?: string;
  /** Разрешённые типы апдейтов. Дефолт — message+callback_query. */
  allowed_updates?: string[];
  drop_pending_updates?: boolean;
}

export function setWebhook(token: string, input: SetWebhookInput): Promise<TgResult<boolean>> {
  return call<boolean>(token, 'setWebhook', input);
}

export function deleteWebhook(
  token: string,
  drop_pending_updates = false,
): Promise<TgResult<boolean>> {
  return call<boolean>(token, 'deleteWebhook', { drop_pending_updates });
}

// ───── Update payload (минимальная типизация — нам нужен только message) ─────

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: { id: string; data?: string; from: TgUser; message?: TgMessage };
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  from?: TgUser;
  text?: string;
  caption?: string;
}
