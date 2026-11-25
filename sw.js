// Keeps a copy of the panel so it can open without internet. Bump VERSION on every release.
const VERSION = 'rv-panel-1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'ble.js', 'protocols.js', 'manifest.webmanifest'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys()
  .then((ks) => Promise.all(ks.filter((k) => k.startsWith('rv-panel-') && k !== VERSION).map((k) => caches.delete(k))))
  .then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
