/**
 * Web Push handler. Подключается к auto-generated SW через workbox.importScripts в vite.config.ts.
 *
 * Вызывает Notification.show() при получении push'а с {title, body, url, tag, data}.
 * При клике открывает указанный url (или /m/queue по умолчанию).
 */

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
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: tag || 'erfolg-default',
      data: { url: url || '/m/queue', ...(data || {}) },
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
      vibrate: [200, 100, 200],
      renotify: true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/m/queue';
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
