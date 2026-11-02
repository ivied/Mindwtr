const CACHE_NAME = 'mindwtr-pwa-v2';
const PRECACHE_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.png', '/logo.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('mindwtr-pwa-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isNavigation = req.mode === 'navigate';
  const isShell = PRECACHE_URLS.includes(url.pathname);
  const isAsset = url.pathname.startsWith('/assets/');
  if (!isNavigation && !isShell && !isAsset) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Only hashed build assets are immutable. Cached HTML can reference
    // chunks removed by a deployment, leaving installed PWAs blank forever.
    if (isAsset) {
      const cached = await cache.match(req);
      if (cached) return cached;
    }
    try {
      const res = await fetch(req);
      const isHtml = (res.headers.get('content-type') || '').includes('text/html');
      if (res.ok && !(isAsset && isHtml)) {
        await cache.put(isNavigation ? '/index.html' : req, res.clone()).catch(() => undefined);
      }
      return res;
    } catch {
      const cached = await cache.match(isNavigation ? '/index.html' : req);
      return cached || Response.error();
    }
  })());
});
