/* Clincoo service worker — PWA + cache aset CDN (lucide, fonts, tailwind) v29 */
var CACHE = 'clinqoo-v29';
var PRECACHE = [
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/og-image.png'
];
// CDN statis yang aman di-cache — icon lucide, fonts, dan library tampil instan
var CDN_HOSTS = [
  'unpkg.com', 'cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
  'cdnjs.cloudflare.com', 'esm.sh', 'cdn.jsdelivr.net'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(PRECACHE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isCdnAsset(url) {
  for (var i = 0; i < CDN_HOSTS.length; i++) {
    if (url.hostname === CDN_HOSTS[i] || url.hostname.endsWith('.' + CDN_HOSTS[i])) return true;
  }
  return false;
}

// stale-while-revalidate: tampilkan dari cache SEGERA (icon/halaman cepat tampil),
// perbarui di latar belakang untuk kunjungan berikutnya.
function swr(req) {
  return caches.match(req).then(function (cached) {
    var fresh = fetch(req).then(function (res) {
      if (res && (res.status === 200 || res.type === 'opaque')) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return cached; });
    return cached || fresh;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // aset CDN (lucide, fonts, tailwind, cdnjs): cache-first — icon tampil seketika
  if (url.origin !== location.origin && isCdnAsset(url)) {
    e.respondWith(swr(req));
    return;
  }
  if (url.origin !== location.origin) return;   // cross-origin lain (mis. API be2): lewati
  if (url.pathname.indexOf('/api/') !== -1) return; // backend/functions: selalu network

  if (req.mode === 'navigate') {
    // Halaman sensitif (login/pembayaran): network-first, fallback cache saat offline.
    var sensitive = url.pathname.indexOf('/auth') === 0 || url.pathname.indexOf('/pay') === 0;
    if (sensitive) {
      e.respondWith(
        fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        }).catch(function () {
          return caches.match(req).then(function (m) { return m || caches.match('./'); });
        })
      );
      return;
    }
    // Halaman lain: stale-while-revalidate — pernah dibuka = tampil INSTAN dari cache,
    // versi terbaru diunduh diam-diam di latar untuk kunjungan berikutnya.
    e.respondWith(swr(req));
    return;
  }

  // aset statis lokal (css/js/img/font): stale-while-revalidate
  e.respondWith(swr(req));
});
