const CACHE = 'jagdkarte-shell-v13';
const SHELL = ['./', './index.html', './style.css', './app.js', './data.js', './config.js',
  './lucide.js', './supabase.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './neuss.geojson',
  './marker-types.json', './markers/hochsitz.svg', './markers/huette.svg', './markers/sonstiges.svg',
  '../GeoLocator/leaflet.js', '../GeoLocator/leaflet.css'];
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