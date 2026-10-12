const CACHE = 'jagdkarte-shell-v23';
const SHELL = ['./', './index.html', './style.css', './app.js', './data.js', './config.js',
  './lucide.js', './supabase.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './neuss.geojson',
  './marker-types.json', './markers/hochsitz.svg', './markers/huette.svg', './markers/leiter.svg',
  './markers/kanzel.svg', './markers/drueckjagdbock.svg', './markers/kirrung.svg', './markers/sonstiges.svg',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png', './vendor/leaflet/LICENSE'];
const shellUrls = new Set(SHELL.map(path => new URL(path, self.location).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('jagdkarte-shell-') && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(new URL('./index.html', self.location).href)));
  } else if (shellUrls.has(event.request.url)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});