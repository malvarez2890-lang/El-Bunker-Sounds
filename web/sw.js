// Service worker mínimo: guarda los archivos de la app para que abra rápido y funcione la instalación.
// La música, las carátulas y la API NUNCA se guardan aquí (son privadas y van siempre al servidor).
const CACHE = 'ebs-shell-v2';

// Avisos al celular (notificaciones push). iOS exige mostrar siempre una notificación cuando llega un aviso.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  event.waitUntil(self.registration.showNotification(d.title || 'El Búnker Sound', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: d.tag || undefined, data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { if ('navigate' in c) c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = req.mode === 'navigate' ? '/' : req;
  // Primero la red (así las actualizaciones llegan al tiro). Si el servidor no contesta, tarda mucho o da un error (502, 503…),
  // se abre la última copia guardada de la app: así la app SIEMPRE abre y puede avisar que el servidor no responde.
  event.respondWith((async () => {
    const cached = await caches.match(key);
    const net = fetch(req).then(async (res) => {
      if (res.ok && res.type === 'basic') { const c = await caches.open(CACHE); c.put(key, res.clone()); }
      return res;
    });
    net.catch(() => {});
    try {
      const res = await Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error('lento')), cached ? 4000 : 25000))]);
      if (res.ok || !cached) return res;
      return cached;
    } catch { return cached || Response.error(); }
  })());
});
