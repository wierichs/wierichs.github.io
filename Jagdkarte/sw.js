const CACHE = 'jagdkarte-shell-v38';
const SHELL = ['./', './index.html', './style.css', './app.js', './data.js', './config.js',
  './lucide.js', './supabase.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './neuss.geojson',
  './marker-types.json', './markers/hochsitz.svg', './markers/huette.svg', './markers/leiter.svg',
  './markers/kanzel.svg', './markers/drueckjagdbock.svg', './markers/kirrung.svg', './markers/sonstiges.svg',
  './markers/falle.svg', './markers/wildkamera.svg',
  './markers/anschuss.svg', './markers/wildsichtung.svg',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png', './vendor/leaflet/LICENSE'];
const shellUrls = new Set(SHELL.map(path => new URL(path, self.location).href));
const markerCatalogUrl = new URL('./marker-types.json', self.location);
const markerBaseUrl = new URL('./markers/', self.location);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll(SHELL.map(path => new Request(new URL(path, self.location), { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('jagdkarte-shell-') && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone()).catch(() => {});
      return response;
    }
    return await cache.match(request) || response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(new URL('./index.html', self.location).href)));
  } else if (url.pathname === markerCatalogUrl.pathname ||
    (url.pathname.startsWith(markerBaseUrl.pathname) && url.pathname.endsWith('.svg'))) {
    event.respondWith(networkFirst(event.request));
  } else if (shellUrls.has(event.request.url)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});