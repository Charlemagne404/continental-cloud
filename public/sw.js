const CACHE = 'continental-cloud-shell-v2';
const SHELL = ['/', '/style.css', '/client/app.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).pathname.startsWith('/api/')) return;
  // Prefer the current server shell so a deployed UI/security fix is never held
  // back by an old service-worker cache; retain offline fallback for the PWA shell.
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) void caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || Response.error())));
});
