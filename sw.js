// sw.js
const CACHE = 'app-cache-v1';
const ASSETS = [
    '/',               // si tu sers à la racine (sinon '/assistant/index.html' etc.)
    '/index.html',
'/style.css',
'/script.js',
'/manifest.json',
'/icons/icon-192.png',
'/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Cache-first pour ASSETS, réseau sinon, avec fallback offline
self.addEventListener('fetch', (event) => {
    const req = event.request;
    event.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;
            return fetch(req).catch(() => {
                // fallback simple : renvoie l’index si offline et HTML
                if (req.headers.get('accept')?.includes('text/html')) {
                    return caches.match('/index.html');
                }
            });
        })
    );
});
