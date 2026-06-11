/**
 * State machine диалога с клиентом в Telegram-боте.
 *
 * Состояние хранится в Redis: `tg:conv:<tenantId>:<chatId>` → JSON со step + answers.
 * TTL 1 час — после неактивности диалог сбрасывается.
 *
 * Шаги (4 уточнения по DoD Этапа 7):
 *   1. ASK_NAME    → spravil сохранить fullName
 *   2. ASK_PHONE   → phone (E.164/Russian formats)
 *   3. ASK_SYMPTOM → краткое описание неисправности (свободный текст)
 *   4. ASK_ADDRESS → где забрать / адрес. После — создание заявки.
 */
import { getRedis } from '../../lib/redis';

export const CONV_TTL_SEC = 60 * 60;

export type ConversationStep =
  | 'IDLE'
  | 'ASK_NAME'
  | 'ASK_PHONE'
  | 'ASK_SYMPTOM'
  | 'ASK_ADDRESS'
  | 'DONE';

export interface ConversationState {
  step: ConversationStep;
  fullName?: string;
  phone?: string;
  symptom?: string;
  address?: string;
  startedAt: number;
}

function key(tenantId: string, chatId: number | string): string {
  return `tg:conv:${tenantId}:${chatId}`;
}

export async function loadConversation(
  tenantId: string,
  chatId: number | string,
): Promise<ConversationState | null> {
  const raw = await getRedis().get(key(tenantId, chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConversationState;
  } catch {
    return null;
  }
}

export async function saveConversation(
  tenantId: string,
  chatId: number | string,
  state: ConversationState,
): Promise<void> {
  await getRedis().set(key(tenantId, chatId), JSON.stringify(state), 'EX', CONV_TTL_SEC);
}

export async function clearConversation(
  tenantId: string,
  chatId: number | string,
): Promise<void> {
  await getRedis().del(key(tenantId, chatId));
}

/** Подсказки пользователю на каждом шаге. */
export const STEP_PROMPTS: Record<ConversationStep, string> = {
  IDLE: '',
  ASK_NAME: 'Здравствуйте! Это бот сервисного центра. Как вас зовут?',
  ASK_PHONE:
    'Спасибо. Какой ваш телефон для связи? Можно в любом формате (например, +7 928 123-45-67).',
  ASK_SYMPTOM:
    'Что сломалось? Кратко опишите неисправность и марку техники, если знаете (например: «УЗИ-аппарат Mindray DC-30, не включается»).',
  ASK_ADDRESS:
    'Где находится техника или куда удобно подъехать? Укажите адрес/организацию.',
  DONE: '',
};

/** Следующий шаг после успешного ответа. */
export function nextStep(current: ConversationStep): ConversationStep {
  switch (current) {
    case 'IDLE':
      return 'ASK_NAME';
    case 'ASK_NAME':
      return 'ASK_PHONE';
    case 'ASK_PHONE':
      return 'ASK_SYMPTOM';
    case 'ASK_SYMPTOM':
      return 'ASK_ADDRESS';
    case 'ASK_ADDRESS':
      return 'DONE';
    case 'DONE':
      return 'DONE';
    default:
      return 'IDLE';
  }
}

/** Применяет ответ пользователя к текущему шагу. Возвращает true если ответ принят. */
export function applyAnswer(state: ConversationState, text: string): boolean {
  const trimmed = text.trim();
  switch (state.step) {
    case 'ASK_NAME':
      if (trimmed.length < 2) return false;
      state.fullName = trimmed.slice(0, 200);
      return true;
    case 'ASK_PHONE': {
      const digits = trimmed.replace(/\D+/g, '');
      if (digits.length < 10) return false;
      state.phone = trimmed.slice(0, 50);
      return true;
    }
    case 'ASK_SYMPTOM':
      if (trimmed.length < 5) return false;
      state.symptom = trimmed.slice(0, 1000);
      return true;
    case 'ASK_ADDRESS':
      if (trimmed.length < 3) return false;
      state.address = trimmed.slice(0, 500);
      return true;
    default:
      return false;
  }
}
