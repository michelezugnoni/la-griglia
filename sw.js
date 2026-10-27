/* ============================================================
   La Griglia — service worker
   Le prenotazioni sono salvate in localStorage: qui mettiamo in
   cache solo l'interfaccia, così l'app si apre anche offline.
   ============================================================ */

const VERSION = 'la-griglia-v1';

const SHELL = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-32.png'
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(VERSION)
            .then(function (cache) {
                return cache.addAll(SHELL);
            })
            .then(function () {
                return self.skipWaiting();
            })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) {
                return Promise.all(keys.map(function (key) {
                    if (key === VERSION) return null;
                    return caches.delete(key);
                }));
            })
            .then(function () {
                return self.clients.claim();
            })
    );
});

self.addEventListener('fetch', function (event) {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
    const cache = await caches.open(VERSION);

    try {
        const response = await fetch(request);
        if (response && response.ok) {
            cache.put(request, response.clone());
            return response;
        }

        // Dietro proxy o server instabili: meglio l'interfaccia in cache di un errore.
        if (response && response.status >= 500) {
            const fallback = await cache.match(request) ||
                (request.mode === 'navigate' ? await cache.match('./index.html') : null);
            if (fallback) return fallback;
        }

        return response;
    } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;

        if (request.mode === 'navigate') {
            const shell = await cache.match('./index.html');
            if (shell) return shell;
        }

        throw error;
    }
}
