// Ada PWA service worker: sadece uygulama kabuğunu önbelleğe alır, /api isteklerine hiç dokunmaz.
// Önce ağ, olmazsa önbellek: Ada güncellenince telefon yeni dosyaları hemen alır, bağlantı
// yokken de uygulama açılıp "bağlantı yok" durumunu gösterebilir.
// Not: Service worker yalnızca HTTPS'te (GitHub Pages, Tailscale) çalışır; evdeki http adreste
// tarayıcı kaydetmez, uygulama yine de çalışır.
const CACHE = 'ada-shell-v1';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'icons.js',
  'style.css',
  'manifest.webmanifest',
  'vendor/xterm.js',
  'vendor/xterm.css',
  'fonts/inter-latin-wght-normal.woff2',
  'fonts/inter-latin-ext-wght-normal.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./'))),
  );
});
