// Сервис-воркер: приложение открывается с телефона и без связи (сотрудники на объектах).
// Файлы интерфейса — «сначала сеть, при сбое — сохранённая копия»: после обновления на сервере
// пользователь сразу получает новую версию, а без связи — последнюю загруженную.
// Запросы /api/ не кэшируются никогда: данные обращений на устройстве не хранятся.
const CACHE = 'golos-v1';
const SHELL = ['/', '/css/styles.css', '/js/app.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request))
        ?? (event.request.mode === 'navigate' ? caches.match('/') : Response.error())),
  );
});

// Push-уведомление: текст расшифровал браузер; по щелчку открывается обращение (или уже открытая вкладка).
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Голос сотрудника', {
    body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: data.url || '/#/home' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/#/home', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.navigate(url);
      return open.focus();
    }
    return self.clients.openWindow(url);
  })());
});
