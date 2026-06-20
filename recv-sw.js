
var _cacheName = 'cimbar-recv-js-v7';
// Relative paths so the app works whether hosted at a domain root
// (Cloudflare Pages) or under a project subpath (GitHub Pages /<repo>/).
var _cacheFiles = [
  './',
  './recv.html',
  './cimbar_js.js',
  './cimbar_js.wasm',
  './favicon.ico',
  './icon-192x192.png',
  './icon-512x512.png',
  './i18n.js',
  './recv.js',
  './recv-worker.js',
  './pwa-recv.json',
  './zstd.js'
];

// fetch files
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(_cacheName).then(function (cache) {
      return cache.addAll(_cacheFiles);
    })
  );
  self.skipWaiting();
});

// serve from cache
self.addEventListener('fetch', function (e) {
  e.respondWith(
    caches.match(e.request).then(function (response) {
      return response || fetch(e.request);
    })
  );
});

// clean old caches
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name != _cacheName) return caches.delete(name);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});
