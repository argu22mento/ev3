const VERSION = 'ev3-v7';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/xlsx-lite.js', '/manifest.webmanifest',
  '/ev3-reposo.jpg', '/ev3-cargando.jpg', '/icon-192.png', '/apple-touch-icon.png', '/favicon.png', '/gasto-final.jpg', '/ev3-intermitentes.jpg', '/ev3-noche.jpg', '/ev3-noche-off.jpg', '/ev3-noche-cargando.jpg', '/ev3-noche-cargando-off.jpg', '/ev3-intermitentes-noche.jpg', '/gasto-final-noche.jpg'];

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
