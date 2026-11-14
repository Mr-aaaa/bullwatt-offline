const scope = self.registration.scope;
const prefix = 'bullwatt-offline:' + scope + ':';
const version = "3bee0be13e443977";
const cacheName = prefix + version;
const relativeAssets = ["./app.mjs","./assets/android-chrome-192x192.png","./assets/android-chrome-512x512.png","./bluetooth.mjs","./charts.mjs","./control.mjs","./dependencies/auuki/src/ble/ftms/control-point.js","./dependencies/auuki/src/ble/ftms/indoor-bike-data.js","./dependencies/auuki/src/ble/hrs/heart-rate-measurement.js","./dependencies/auuki/src/functions.js","./index.html","./manifest.webmanifest","./session.mjs","./storage.mjs","./styles.css"];
const entry = new URL('./index.html', scope).href;
const assets = new Set(relativeAssets.map(path => new URL(path, scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(
    [...assets].map(url => new Request(url, { cache: 'reload' })),
  )));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(prefix) && key !== cacheName).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  const navigation = event.request.mode === 'navigate' && (url.href === scope || url.href === entry);
  if (!navigation && !assets.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return (await cache.match(navigation ? entry : url.href)) ?? fetch(event.request);
  })());
});
