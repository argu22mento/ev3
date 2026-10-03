const VERSION = 'ev3-v9';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/xlsx-lite.js', '/manifest.webmanifest',
  '/ev3-car.webp', '/ev3-car-carga.webp', '/ev3-carga-luz.webp', '/ev3-intermitente.webp',
  '/ev3-luces-delante.webp', '/ev3-luces-detras.webp',
  '/ev3-rueda-1.webp', '/ev3-rueda-2.webp', '/ev3-rueda-3.webp', '/ev3-rueda-4.webp',
  '/icon-192.png', '/apple-touch-icon.png', '/favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
const put = (req, res) => { if (res.ok) { const cp = res.clone(); caches.open(VERSION).then(c => c.put(req, cp)); } return res; };
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Vídeo: lo gestiona el navegador directamente (peticiones por rangos en Safari)
  if (/\.(mp4|webm)$/.test(url.pathname) || e.request.headers.has('range')) return;
  // Precios y código de la app: red primero (siempre la última versión), caché si no hay conexión
  const code = url.origin === location.origin && (e.request.mode === 'navigate' || /\.(html|js|css|webmanifest)$/.test(url.pathname) || url.pathname === '/');
  if (code || url.pathname.startsWith('/api/') || url.hostname === 'apidatos.ree.es') {
    e.respondWith(fetch(e.request).then(r => put(e.request, r))
      .catch(() => caches.match(e.request).then(h => h || (e.request.mode === 'navigate' ? caches.match('/index.html') : undefined))));
    return;
  }
  if (url.origin !== location.origin) return;
  // Imágenes: caché primero
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => put(e.request, r))));
});
