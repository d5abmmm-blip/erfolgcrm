/**
 * Web Push фасад. Тонкая обёртка над `web-push` npm-пакетом.
 *
 * Конфигурация через env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:).
 * Если ключи не заданы — публичный ключ всё равно возвращается (пусто), а sendPush() кидает.
 *
 * Перед использованием: `npx web-push generate-vapid-keys` и положить в .env.
 */
import webpush, { type PushSubscription, type SendResult, WebPushError } from 'web-push';
import { logger } from './logger';

let _configured = false;

function configure(): void {
  if (_configured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:erfolgmt@mail.ru';
  if (!publicKey || !privateKey) {
    logger.warn('VAPID keys not set — web-push отключён, push-уведомления будут падать с ошибкой при попытке отправки');
    _configured = true;
    return;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  _configured = true;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Куда вести при клике. Например `/m/queue?ticketId=...` */
  url?: string;
  /** Идентификатор темы — браузер схлопнет одинаковые. */
  tag?: string;
  /** Произвольные данные для SW. */
  data?: Record<string, unknown>;
}

export interface SerializedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type SendOutcome =
  | { ok: true; statusCode: number }
  | { ok: false; gone: true; statusCode: number }
  | { ok: false; gone: false; statusCode: number; error: string };

/** Отправить push на одну подписку. Возвращает структурированный результат, не throws. */
export async function sendPush(
  subscription: SerializedSubscription,
  payload: PushPayload,
): Promise<SendOutcome> {
  configure();
  const sub: PushSubscription = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  };
  try {
    const res: SendResult = await webpush.sendNotification(sub, JSON.stringify(payload), {
      TTL: 60 * 60, // 1 час
      urgency: 'high',
    });
    return { ok: true, statusCode: res.statusCode };
  } catch (err: unknown) {
    if (err instanceof WebPushError) {
      const gone = err.statusCode === 404 || err.statusCode === 410;
      return gone
        ? { ok: false, gone: true, statusCode: err.statusCode }
        : { ok: false, gone: false, statusCode: err.statusCode, error: err.body || err.message };
    }
    return { ok: false, gone: false, statusCode: 0, error: (err as Error).message };
  }
}
