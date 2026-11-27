// Gemmer selve appen, så den åbner hurtigt og virker uden net (kortopslag kræver net).
const CACHE = 'kortscanner-v21';
const SHELL = ['./', 'index.html', 'style.css?v=21', 'app.js?v=21', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin){
    // netværk først, så opdateringer kommer med; cache som reserve
    e.respondWith(fetch(e.request, {cache:'no-cache'}).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
  } else if (u.hostname === 'assets.tcgdex.net'){
    // kortbilleder: cache først
    e.respondWith(caches.open('kortscanner-img').then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }))));
  }
});
