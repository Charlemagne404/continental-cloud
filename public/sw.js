const CACHE = 'continental-cloud-shell-v5';
const SHELL = ['/', '/style.css', '/client/app.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'clear-private-cache') return;
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    const keys = await cache.keys();
    await Promise.all(keys.filter((request) => new URL(request.url).pathname.startsWith('/api/files/')).map((request) => cache.delete(request)));
  }));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isRecentFile = /^\/api\/files\/[0-9a-f-]{36}\/(content|thumbnail)$/i.test(url.pathname);
  const allowPrivateCache = isRecentFile && url.searchParams.get('offline-cache') === '1';
  if (event.request.method !== 'GET' || (url.pathname.startsWith('/api/') && !allowPrivateCache)) return;
  // Prefer the current server shell so a deployed UI/security fix is never held
  // back by an old service-worker cache; retain offline fallback for the PWA shell.
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && (!url.pathname.startsWith('/api/') || allowPrivateCache)) void caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || Response.error())));
});
