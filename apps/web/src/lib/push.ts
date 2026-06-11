/**
 * Web Push клиент: запрашивает permission, регистрирует подписку через PushManager,
 * отправляет endpoint+keys на сервер через trpc.notifications.subscribe.
 *
 * Использует уже зарегистрированный SW от vite-plugin-pwa (autoUpdate).
 */
import { trpcClient } from './trpc';

export type PushStatus =
  | { state: 'unsupported' }
  | { state: 'denied' }
  | { state: 'idle' }
  | { state: 'subscribed' };

export function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!isPushSupported()) return { state: 'unsupported' };
  if (Notification.permission === 'denied') return { state: 'denied' };
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { state: 'idle' };
  const sub = await reg.pushManager.getSubscription();
  return sub ? { state: 'subscribed' } : { state: 'idle' };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const buf = new ArrayBuffer(rawData.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i];
    if (b !== undefined) bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

/**
 * Запросить permission и зарегистрировать подписку.
 * Возвращает ok:true при успехе, иначе reason.
 */
export async function enablePush(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: 'denied' };

  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) reg = await navigator.serviceWorker.ready;

  const { publicKey } = await trpcClient.notifications.publicKey.query();
  if (!publicKey) return { ok: false, reason: 'no-vapid' };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh ?? arrayBufferToBase64(sub.getKey('p256dh'));
  const auth = json.keys?.auth ?? arrayBufferToBase64(sub.getKey('auth'));
  if (!p256dh || !auth) return { ok: false, reason: 'no-keys' };

  await trpcClient.notifications.subscribe.mutate({
    endpoint: sub.endpoint,
    p256dh,
    auth,
  });
  return { ok: true };
}

/** Отписаться. */
export async function disablePush(): Promise<{ ok: true }> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { ok: true };
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { ok: true };
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await trpcClient.notifications.unsubscribe.mutate({ endpoint }).catch(() => undefined);
  return { ok: true };
}
