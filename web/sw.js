/* Tiderip service worker: cache app shell (cache-first) and forecast data
   (network-first, falling back to last cached copy when offline). */
const SHELL = 'tiderip-shell-v8';
const DATA = 'tiderip-data-v1';
const SHELL_FILES = [
  './', 'index.html', 'app.js', 'manifest.webmanifest',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/data/')) {
    // network-first: fresh forecast when online, cached forecast at anchor
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(DATA).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
  } else if (url.hostname.includes('tile.openstreetmap.org') || url.hostname.includes('tiles.openseamap.org')) {
    // cache-then-network for map tiles so the last-viewed area works offline
    e.respondWith(
      caches.open(DATA).then(async c => {
        const hit = await c.match(e.request);
        const net = fetch(e.request).then(r => { c.put(e.request, r.clone()); return r; }).catch(() => hit);
        return hit || net;
      })
    );
  } else {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
  }
});
