/* BimRadar service worker — caches the app shell for instant, installable loads.
   Live data (HAFAS POSTs, basemap tiles, Photon) is never cached: it must stay fresh.
   Bump CACHE when index.html or the pinned MapLibre version changes. */
const CACHE = 'bimradar-v46';
const SHELL = [
  './', './index.html', './lines.json', './manifest.json',
  './icon-192.png?v=2', './icon-512.png?v=2', './icon-180.png?v=2', './icon-32.png?v=2',
  './maplibre-gl.js?v=4.7.1', './maplibre-gl.css?v=4.7.1'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))  // one bad URL mustn't fail the install
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // HAFAS is POST — leave it alone
  const url = new URL(req.url);

  // navigations: network-first, fall back to the cached shell when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  // live data must never come from cache
  if (url.pathname.includes('/api/')) return;
  // same-origin assets: cache-first, and refresh the cache in the background
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(resp => {
        if (resp.ok) { const cl = resp.clone(); caches.open(CACHE).then(c => c.put(req, cl)); }
        return resp;
      }).catch(() => hit))
    );
    return;
  }
  // everything else (tiles, Photon, fonts): straight to the network
});
