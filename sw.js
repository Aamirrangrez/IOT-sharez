const CACHE_NAME = 'smart-home-v3';

// Only cache local files — external CDN resources are fetched live
const LOCAL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/icon.png',
  '/manifest.json'
];

// Install — cache files one by one (won't crash on a single failure)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        LOCAL_FILES.map(url =>
          cache.add(url).catch(() => {
            console.warn('[SW] Failed to cache:', url);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// Activate — remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — serve from cache, fall back to network
self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).catch(() => {
        // Offline fallback: return index.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});