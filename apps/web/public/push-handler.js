/**
 * Web Push handler. Подключается к auto-generated SW через workbox.importScripts в vite.config.ts.
 *
 * Вызывает Notification.show() при получении push'а с {title, body, url, tag, data}.
 * При клике открывает указанный url (или /m/queue по умолчанию).
 *
 * Нуджи инженеру (data.actions === true) получают кнопки быстрого ответа:
 * нажатие открывает /m/queue?react=<action>&ticket=<id> — страница «Мой день»
 * выполняет мутацию сама (с живой сессией и offline-очередью).
 * Кнопки в уведомлениях поддерживают не все платформы (iOS Safari — нет);
 * без них уведомление ведёт себя как обычное.
 */

var NUDGE_ACTIONS = [
  { action: 'inwork', title: 'Ещё в работе' },
  { action: 'ready', title: 'Готово к выдаче' },
  { action: 'part', title: 'Жду запчасть' },
];

self.addEventListener('push', (event) => {
  let payload = { title: 'ErfolgCRM', body: 'Новое уведомление' };
  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch (_e) {
    // событие без JSON-payload — оставляем дефолт
  }
  const { title, body, url, tag, data } = payload;
  const options = {
    body,
    tag: tag || 'erfolg-default',
    data: { url: url || '/m/queue', ...(data || {}) },
    icon: '/pwa-192.png',
    badge: '/pwa-192.png',
    vibrate: [200, 100, 200],
    renotify: true,
  };
  if (data && data.actions && data.ticketId) {
    options.actions = NUDGE_ACTIONS;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let targetUrl = data.url || '/m/queue';
  if (event.action && data.ticketId) {
    targetUrl = '/m/queue?react=' + event.action + '&ticket=' + data.ticketId;
  }
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of allClients) {
        if (c.url.includes(targetUrl) && 'focus' in c) {
          return c.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })(),
  );
});
