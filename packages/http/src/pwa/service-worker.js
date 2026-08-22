// The service worker this deployment serves at `/sw.js`.
//
// **A file, because it is a program.** It lived in a template literal inside
// `main.ts`, which meant no syntax check, no formatter and no editor knew it
// was JavaScript — and every function in it counted as a function of `main.ts`
// that nothing in this process could ever call, because in this process it is
// text. Ten of them, which was most of that file's uncovered functions.
//
// `__BUILD_VERSION__` is replaced when the route serves this. It is a
// placeholder rather than an interpolation for the same reason: a file with
// `${...}` in it is not JavaScript that runs anywhere.

const CACHE_VERSION = '__BUILD_VERSION__';
const CACHE_NAME = 'mesh-' + CACHE_VERSION;

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network-first strategy — always get fresh content
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'Agent Mesh', body: 'New message' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.svg',
      badge: '/icon-192.svg',
      tag: 'mesh-' + (data.data?.agent || 'default'),
      renotify: true,
      data: data.data || {},
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const agent = e.notification.data?.agent || '';
  const url = agent ? '/chat/' + encodeURIComponent(agent) : '/chat';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      // Try to reuse existing window — use postMessage instead of navigate()
      // to avoid Chrome Android showing its "URL copy" notification
      for (const c of list) {
        try {
          c.postMessage({ type: 'navigate', url });
          return c.focus();
        } catch {}
      }
      // No existing window — open new one
      return clients.openWindow(url);
    })
  );
});
