// sw.js — v3
// - Fonctionne en sous-dossier (GitHub Pages / localhost)
// - Cache versionné + nettoyage
// - NE PAS intercepter les requêtes externes (CDN, API…) → évite les erreurs de police
// - HTML: network-first (+fallback cache/index)
// - Assets locaux: cache-first

const CACHE = 'multiapp-cache-v3';
const ORIGIN = self.location.origin;

// Chemins RELATIFS au dossier d'index.html
const ASSETS = [
  'index.html',
'style.css',
'script.js',
'manifest.json',
'icons/icon-192.png',
'icons/icon-512.png',
'favicon.ico'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
    Promise.all(keys.map(k => (k !== CACHE) && caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 0) Laisser passer tout ce qui n'est PAS même origine (CDN, APIs…)
  if (url.origin !== ORIGIN) return;

  // 1) Requêtes de navigation (HTML)
  const isHTML = req.mode === 'navigate'
  || (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    event.respondWith(
      fetch(req)
      .then(resp => {
        // Met à jour le cache en arrière-plan
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put('index.html', copy)).catch(()=>{});
        return resp;
      })
      .catch(async () =>
      (await caches.match(req)) || (await caches.match('index.html'))
      )
    );
    return;
  }

  // 2) Uniquement GET locaux → cache-first
  if (req.method === 'GET') {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(req, clone)).catch(()=>{});
          }
          return resp;
        }).catch(() => undefined);
      })
    );
  }
});
