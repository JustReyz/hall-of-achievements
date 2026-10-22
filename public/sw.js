// public/sw.js — Hall of Achievements Minimal Web Push Service Worker
// Strictly handles push and notificationclick only.
// NO fetch handler. NO Cache API.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let title = 'Hall of Achievements';
  let body = 'New reminder from Hall of Achievements';
  let targetUrl = '/';

  if (event.data) {
    try {
      const payload = event.data.json();
      if (payload.title) title = payload.title;
      if (payload.body) body = payload.body;
      if (payload.url) targetUrl = payload.url;
    } catch {
      const text = event.data.text();
      if (text) body = text;
    }
  }

  const options = {
    body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: 'hall-of-achievements-reminder',
    renotify: true,
    data: { url: targetUrl },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url && client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    })
  );
});
